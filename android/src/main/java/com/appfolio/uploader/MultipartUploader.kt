package com.appfolio.uploader

import android.content.Context
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.MediaType
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

class UploadAlreadyExistsException(message: String) : Exception(message)

class MultipartUploader(private val reactContext: ReactApplicationContext) {
    companion object {
        private const val TAG = "MultipartUploader"
        private const val MIN_CHUNK_SIZE = 5L * 1024 * 1024 // 5MB minimum for S3
        private const val MAX_RETRIES = 3
    }

    private class HttpStatusException(val code: Int, message: String) : Exception(message) {
        val isRetryable: Boolean
            get() = code >= 500 || code == 408 || code == 429
    }

    private class FileRegionBody(
        private val file: File,
        private val offset: Long,
        private val size: Long,
        private val mediaType: MediaType?
    ) : RequestBody() {
        override fun contentType(): MediaType? = mediaType

        override fun contentLength(): Long = size

        override fun writeTo(sink: BufferedSink) {
            RandomAccessFile(file, "r").use { raf ->
                if (offset + size > raf.length()) {
                    throw IllegalArgumentException("Invalid chunk bounds: offset=$offset, size=$size, file=${raf.length()}")
                }
                raf.seek(offset)
                val buffer = ByteArray(64 * 1024)
                var remaining = size
                while (remaining > 0) {
                    val read = raf.read(buffer, 0, Math.min(buffer.size.toLong(), remaining).toInt())
                    if (read < 0) {
                        throw IOException("Unexpected end of file while reading chunk")
                    }
                    sink.write(buffer, 0, read)
                    remaining -= read
                }
            }
        }
    }

    private class NotificationTexts(private val map: ReadableMap?, filename: String) {
        private fun string(key: String, default: String): String =
            if (map != null && map.hasKey(key) && map.getType(key) == ReadableType.String) map.getString(key) ?: default else default

        val title = string("onProgressTitle", filename)
        val startMessage = string("onStartMessage", "Starting upload...")
        val resumeMessage = string("onResumeMessage", "Resuming upload...")
        val progressMessage = string("onProgressMessage", "Uploading... {progress}%")
        val channelName = string("notificationChannelName", "Background Upload Channel")
    }

    private data class PartInfo(
        val partNumber: Int,
        val url: String,
        val offset: Long,
        val size: Long
    )

    private data class UploadJob(
        val uploadId: String,
        val job: CompletableJob = Job(),
        val isPaused: AtomicBoolean = AtomicBoolean(false),
        val totalBytes: Long,
        val partsCount: Int,
        val bytesUploaded: AtomicLong,
        val completedChunks: AtomicLong,
        val partETags: ConcurrentHashMap<Int, String>,
        val activeCalls: ConcurrentHashMap<Int, Call> = ConcurrentHashMap()
    )

    private val activeUploads = ConcurrentHashMap<String, UploadJob>()

    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private fun emitEvent(eventName: String, params: WritableMap) {
        try {
            reactContext.getJSModule(RCTDeviceEventEmitter::class.java)?.emit(eventName, params)
        } catch (e: Exception) {
            Log.e(TAG, "Error emitting event $eventName: ${e.message}")
        }
    }

    private fun cleanFilePath(path: String): String {
        return if (path.startsWith("file://")) {
            path.substring(7)
        } else {
            path
        }
    }

    suspend fun startMultipartUpload(options: ReadableMap): WritableMap = withContext(Dispatchers.IO) {
        val uploadId = options.getString("uploadId")
            ?: throw IllegalArgumentException("uploadId is required")
        val rawPath = options.getString("path")
            ?: throw IllegalArgumentException("path is required")
        val filePath = cleanFilePath(rawPath)

        val file = File(filePath)
        if (!file.exists() || !file.isFile) {
            throw IllegalArgumentException("File does not exist at path: $filePath")
        }

        val partsArray = options.getArray("parts")
            ?: throw IllegalArgumentException("parts is required")
        val partsCount = partsArray.size()
        if (partsCount == 0) {
            throw IllegalArgumentException("parts array cannot be empty")
        }

        val uploadUrls = Array(partsCount) { i -> partsArray.getString(i)!! }
        val maxParallel = if (options.hasKey("maxParallel") && options.getType("maxParallel") == ReadableType.Number) {
            options.getInt("maxParallel")
        } else {
            3
        }

        val notificationMap = if (options.hasKey("notification") && options.getType("notification") == ReadableType.Map) {
            options.getMap("notification")
        } else null

        val showNotification = notificationMap?.hasKey("enabled") == true && notificationMap.getBoolean("enabled")
        val filename = notificationMap?.getString("filename") ?: file.name
        val texts = NotificationTexts(notificationMap, filename)

        val fileSize = file.length()
        if (fileSize <= 0) {
            throw IllegalArgumentException("File is empty or invalid: $filePath")
        }

        // S3 multipart requires all parts except the last to be >= 5MB (MIN_CHUNK_SIZE).
        // If fileSize <= (partsCount - 1) * MIN_CHUNK_SIZE, partsCount is invalid for this file size.
        val minRequiredSize = MIN_CHUNK_SIZE * (partsCount - 1)
        if (partsCount > 1 && fileSize <= minRequiredSize) {
            throw IllegalArgumentException(
                "File size ($fileSize bytes) is too small for $partsCount parts. Minimum required size: " + (minRequiredSize + 1) + " bytes."
            )
        }

        val calculatedChunkSize = Math.ceil(fileSize.toDouble() / partsCount).toLong()
        val chunkSize = Math.max(calculatedChunkSize, MIN_CHUNK_SIZE)

        val existingEtagsArray = if (options.hasKey("existingEtags") && options.getType("existingEtags") == ReadableType.Array) {
            options.getArray("existingEtags")
        } else null

        val initialETags = ConcurrentHashMap<Int, String>()
        var initialUploadedBytes = 0L
        var initialCompleted = 0L

        if (existingEtagsArray != null) {
            val count = Math.min(existingEtagsArray.size(), partsCount)
            for (i in 0 until count) {
                val etag = existingEtagsArray.getString(i)
                if (!etag.isNullOrEmpty()) {
                    val partNumber = i + 1
                    val offset = i * chunkSize
                    val size = if (i == partsCount - 1) fileSize - offset else chunkSize
                    initialETags[partNumber] = etag
                    initialUploadedBytes += size
                    initialCompleted++
                }
            }
        }

        val parentJob = coroutineContext[Job] ?: Job()
        val uploadJob = UploadJob(
            uploadId = uploadId,
            job = Job(parentJob),
            totalBytes = fileSize,
            partsCount = partsCount,
            bytesUploaded = AtomicLong(initialUploadedBytes),
            completedChunks = AtomicLong(initialCompleted),
            partETags = initialETags
        )
        if (activeUploads.putIfAbsent(uploadId, uploadJob) != null) {
            uploadJob.job.cancel()
            throw UploadAlreadyExistsException("Upload already in progress for $uploadId")
        }

        val context: Context? = reactContext.applicationContext
        if (context != null && showNotification) {
            val startMsg = if (initialUploadedBytes > 0) texts.resumeMessage else texts.startMessage
            MultipartUploadService.start(context, texts.title, startMsg, texts.channelName)
        }

        if (initialUploadedBytes > 0) {
            val progress = if (fileSize > 0) {
                initialUploadedBytes.toDouble() / fileSize.toDouble()
            } else 1.0
            val progressParams = Arguments.createMap()
            progressParams.putString("uploadId", uploadId)
            progressParams.putDouble("progress", progress)
            progressParams.putDouble("bytesUploaded", initialUploadedBytes.toDouble())
            progressParams.putDouble("totalBytes", fileSize.toDouble())
            progressParams.putInt("chunkIndex", (initialCompleted - 1).toInt())
            val currentEtags = Arguments.createArray()
            for (i in 0 until partsCount) {
                val pNum = i + 1
                currentEtags.pushString(initialETags[pNum] ?: "")
            }
            progressParams.putArray("etags", currentEtags)
            emitEvent("RNFileUploader-multipart-progress", progressParams)
        }

        try {
            withContext(uploadJob.job) {
                val parts = uploadUrls.mapIndexed { index, url ->
                    val partNumber = index + 1
                    val offset = index * chunkSize
                    val size = if (index == partsCount - 1) {
                        fileSize - offset
                    } else {
                        chunkSize
                    }
                    if (size <= 0) {
                        throw IllegalArgumentException(
                            "Part $partNumber has invalid size ($size bytes). Offset: $offset, FileSize: $fileSize"
                        )
                    }
                    PartInfo(partNumber, url, offset, size)
                }

                val semaphore = Semaphore(maxParallel)
                val chunkJobs = parts.map { part ->
                    async {
                        semaphore.withPermit {
                            uploadPart(file, part, uploadJob, texts, showNotification)
                        }
                    }
                }

                chunkJobs.awaitAll()

                if (uploadJob.completedChunks.get() < partsCount) {
                    throw Exception("Upload incomplete: completed ${uploadJob.completedChunks.get()} of $partsCount chunks")
                }

                val sortedETags = uploadJob.partETags.toSortedMap().values.toList()

                // Emit completion event
                val completionParams = Arguments.createMap()
                completionParams.putString("uploadId", uploadId)
                completionParams.putBoolean("success", true)
                val completionEtags = Arguments.createArray()
                sortedETags.forEach { completionEtags.pushString(it) }
                completionParams.putArray("etags", completionEtags)
                emitEvent("RNFileUploader-multipart-completed", completionParams)

                val resultMap = Arguments.createMap()
                resultMap.putString("uploadId", uploadId)
                resultMap.putBoolean("success", true)
                val resultEtags = Arguments.createArray()
                sortedETags.forEach { resultEtags.pushString(it) }
                resultMap.putArray("etags", resultEtags)
                resultMap
            }
        } catch (e: CancellationException) {
            val cancelParams = Arguments.createMap()
            cancelParams.putString("uploadId", uploadId)
            cancelParams.putString("error", "Upload cancelled")
            emitEvent("RNFileUploader-multipart-cancelled", cancelParams)
            throw e
        } catch (e: Exception) {
            Log.e(TAG, "Multipart upload failed for $uploadId: ${e.message}", e)
            val errorParams = Arguments.createMap()
            errorParams.putString("uploadId", uploadId)
            errorParams.putString("error", e.message ?: "Upload failed")
            emitEvent("RNFileUploader-multipart-error", errorParams)
            throw e
        } finally {
            uploadJob.job.complete()
            activeUploads.remove(uploadId, uploadJob)
            if (activeUploads.isEmpty() && context != null) {
                MultipartUploadService.stop(context)
            }
        }
    }

    private suspend fun uploadPart(
        file: File,
        part: PartInfo,
        uploadJob: UploadJob,
        texts: NotificationTexts,
        showNotification: Boolean
    ): Boolean = withContext(Dispatchers.IO) {
        if (uploadJob.partETags.containsKey(part.partNumber)) {
            return@withContext true
        }

        var retries = 0
        var lastError: Exception? = null

        while (retries < MAX_RETRIES) {
            while (uploadJob.isPaused.get()) {
                delay(500)
            }

            if (!isActive || uploadJob.job.isCancelled) {
                throw CancellationException("Upload cancelled")
            }

            try {
                if (!file.exists()) {
                    uploadJob.activeCalls.values.forEach { call ->
                        try { call.cancel() } catch (_: Exception) {}
                    }
                    uploadJob.job.cancel()
                    throw CancellationException("Upload cancelled: file deleted")
                }

                val mediaType = "application/octet-stream".toMediaTypeOrNull()
                val requestBody = FileRegionBody(file, part.offset, part.size, mediaType)

                val request = Request.Builder()
                    .url(part.url)
                    .put(requestBody)
                    .build()

                val call = httpClient.newCall(request)
                uploadJob.activeCalls[part.partNumber] = call

                val response = try {
                    call.execute()
                } finally {
                    uploadJob.activeCalls.remove(part.partNumber)
                }

                if (!response.isSuccessful) {
                    val errorBody = response.body?.string() ?: ""
                    throw HttpStatusException(response.code, "HTTP ${response.code}: $errorBody")
                }

                val etag = response.header("ETag")?.trim('"')
                    ?: response.header("etag")?.trim('"')
                    ?: ""

                if (etag.isEmpty()) {
                    throw Exception("No ETag in response for part ${part.partNumber}")
                }

                synchronized(uploadJob) {
                    if (!uploadJob.partETags.containsKey(part.partNumber)) {
                        uploadJob.partETags[part.partNumber] = etag
                        uploadJob.completedChunks.incrementAndGet()
                        uploadJob.bytesUploaded.addAndGet(part.size)
                    }
                }

                val progress = if (uploadJob.totalBytes > 0) {
                    uploadJob.bytesUploaded.get().toDouble() / uploadJob.totalBytes.toDouble()
                } else 1.0

                val progressParams = Arguments.createMap()
                progressParams.putString("uploadId", uploadJob.uploadId)
                progressParams.putDouble("progress", progress)
                progressParams.putDouble("bytesUploaded", uploadJob.bytesUploaded.get().toDouble())
                progressParams.putDouble("totalBytes", uploadJob.totalBytes.toDouble())
                progressParams.putInt("chunkIndex", part.partNumber - 1)
                progressParams.putString("etag", etag)
                val currentEtags = Arguments.createArray()
                for (i in 0 until uploadJob.partsCount) {
                    val pNum = i + 1
                    currentEtags.pushString(uploadJob.partETags[pNum] ?: "")
                }
                progressParams.putArray("etags", currentEtags)
                emitEvent("RNFileUploader-multipart-progress", progressParams)

                val context: Context? = reactContext.applicationContext
                if (context != null && showNotification) {
                    val percent = (progress * 100).toInt()
                    MultipartUploadService.updateProgress(context, texts.title, percent, texts.progressMessage.replace("{progress}", percent.toString()))
                }

                return@withContext true
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (e is java.io.FileNotFoundException || !file.exists()) {
                    uploadJob.activeCalls.values.forEach { call ->
                        try { call.cancel() } catch (_: Exception) {}
                    }
                    uploadJob.job.cancel()
                    throw CancellationException("Upload cancelled: file deleted")
                }
                if (e is HttpStatusException && !e.isRetryable) {
                    throw e
                }
                lastError = e
                retries++
                Log.w(TAG, "Part ${part.partNumber} failed (attempt $retries): ${e.message}")
                if (retries < MAX_RETRIES) {
                    delay(1000L * retries)
                }
            }
        }

        throw lastError ?: Exception("Part ${part.partNumber} failed after $MAX_RETRIES retries")
    }

    fun cancelUpload(uploadIdOrKey: String): Boolean {
        val uploadJob = activeUploads[uploadIdOrKey] ?: return false
        uploadJob.activeCalls.values.forEach { call ->
            try {
                call.cancel()
            } catch (_: Exception) {}
        }
        uploadJob.job.cancel()
        return true
    }

    fun pauseUpload(uploadId: String): Boolean {
        val uploadJob = activeUploads[uploadId] ?: return false
        uploadJob.isPaused.set(true)
        return true
    }

    fun resumeUpload(uploadId: String): Boolean {
        val uploadJob = activeUploads[uploadId] ?: return false
        uploadJob.isPaused.set(false)
        return true
    }
}
