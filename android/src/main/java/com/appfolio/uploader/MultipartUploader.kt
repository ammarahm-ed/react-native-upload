package com.appfolio.uploader

import android.content.Context
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

class UploadAlreadyExistsException(message: String) : Exception(message)

data class UploadParams(
    val uploadId: String,
    val path: String,
    val parts: List<String>,
    val maxParallel: Int,
    val notificationEnabled: Boolean,
    val title: String,
    val startMessage: String,
    val resumeMessage: String,
    val progressMessage: String,
    val channelName: String,
    val existingEtags: List<String>
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("uploadId", uploadId)
        put("path", path)
        put("parts", JSONArray(parts))
        put("maxParallel", maxParallel)
        put("notificationEnabled", notificationEnabled)
        put("title", title)
        put("startMessage", startMessage)
        put("resumeMessage", resumeMessage)
        put("progressMessage", progressMessage)
        put("channelName", channelName)
    }

    companion object {
        fun fromJson(json: JSONObject, existingEtags: List<String>): UploadParams {
            val partsJson = json.getJSONArray("parts")
            return UploadParams(
                uploadId = json.getString("uploadId"),
                path = json.getString("path"),
                parts = List(partsJson.length()) { partsJson.getString(it) },
                maxParallel = json.getInt("maxParallel"),
                notificationEnabled = json.getBoolean("notificationEnabled"),
                title = json.getString("title"),
                startMessage = json.getString("startMessage"),
                resumeMessage = json.getString("resumeMessage"),
                progressMessage = json.getString("progressMessage"),
                channelName = json.getString("channelName"),
                existingEtags = existingEtags
            )
        }

        fun fromReadableMap(options: ReadableMap): UploadParams {
            val uploadId = options.getString("uploadId")
                ?: throw IllegalArgumentException("uploadId is required")
            val rawPath = options.getString("path")
                ?: throw IllegalArgumentException("path is required")
            val path = if (rawPath.startsWith("file://")) rawPath.substring(7) else rawPath

            val partsArray = options.getArray("parts")
                ?: throw IllegalArgumentException("parts is required")
            if (partsArray.size() == 0) {
                throw IllegalArgumentException("parts array cannot be empty")
            }
            val parts = List(partsArray.size()) { i -> partsArray.getString(i)!! }

            val maxParallel = if (options.hasKey("maxParallel") && options.getType("maxParallel") == ReadableType.Number) {
                options.getInt("maxParallel")
            } else {
                3
            }

            val notification = if (options.hasKey("notification") && options.getType("notification") == ReadableType.Map) {
                options.getMap("notification")
            } else null

            fun text(key: String, default: String): String =
                if (notification != null && notification.hasKey(key) && notification.getType(key) == ReadableType.String) {
                    notification.getString(key) ?: default
                } else default

            val enabled = notification?.hasKey("enabled") == true && notification.getBoolean("enabled")
            val filename = text("filename", File(path).name)

            val existing = if (options.hasKey("existingEtags") && options.getType("existingEtags") == ReadableType.Array) {
                val array = options.getArray("existingEtags")!!
                List(array.size()) { i -> array.getString(i) ?: "" }
            } else emptyList()

            return UploadParams(
                uploadId = uploadId,
                path = path,
                parts = parts,
                maxParallel = maxParallel,
                notificationEnabled = enabled,
                title = text("onProgressTitle", filename),
                startMessage = text("onStartMessage", "Starting upload..."),
                resumeMessage = text("onResumeMessage", "Resuming upload..."),
                progressMessage = text("onProgressMessage", "Uploading... {progress}%"),
                channelName = text("notificationChannelName", "Background Upload Channel"),
                existingEtags = existing
            )
        }
    }
}

class MultipartUploader private constructor(private val appContext: Context) {
    companion object {
        private const val TAG = "MultipartUploader"
        private const val MIN_CHUNK_SIZE = 5L * 1024 * 1024
        private const val MAX_RETRIES = 3
        private const val ACK_GRACE_MS = 30_000L
        private const val HEADLESS_ACK_GRACE_MS = 120_000L
        private const val KEEP_ALIVE_TASK = "RNMultipartUploadKeepAlive"
        private const val STATE_FILE = "rn-multipart-uploads.json"

        const val STATUS_RUNNING = "running"
        const val STATUS_COMPLETED = "completed"
        const val STATUS_FAILED = "failed"

        @Volatile
        private var instance: MultipartUploader? = null

        fun getInstance(context: Context): MultipartUploader =
            instance ?: synchronized(this) {
                instance ?: MultipartUploader(context.applicationContext).also { instance = it }
            }
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

    private data class PartInfo(
        val partNumber: Int,
        val url: String,
        val offset: Long,
        val size: Long
    )

    private class Record(
        val params: UploadParams,
        val totalBytes: Long,
        val chunkSize: Long,
        @Volatile var etags: Array<String>,
        @Volatile var status: String,
        @Volatile var error: String?
    ) {
        fun sizeOf(index: Int): Long {
            val offset = index * chunkSize
            return if (index == params.parts.size - 1) totalBytes - offset else chunkSize
        }

        fun bytesUploaded(): Long {
            var bytes = 0L
            for (i in etags.indices) {
                if (etags[i].isNotEmpty()) bytes += sizeOf(i)
            }
            return bytes
        }
    }

    private class UploadJob(
        val uploadId: String,
        val totalBytes: Long,
        val partsCount: Int,
        val bytesUploaded: AtomicLong,
        val completedChunks: AtomicLong,
        val partETags: ConcurrentHashMap<Int, String>,
        val isPaused: AtomicBoolean = AtomicBoolean(false),
        val activeCalls: ConcurrentHashMap<Int, Call> = ConcurrentHashMap()
    ) {
        @Volatile
        var job: Job? = null

        @Volatile
        var cancelledByUser = false

        fun cancel() {
            activeCalls.values.forEach { call ->
                try { call.cancel() } catch (_: Exception) {}
            }
            job?.cancel()
        }
    }

    private val engineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val ackScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val records = ConcurrentHashMap<String, Record>()
    private val activeUploads = ConcurrentHashMap<String, UploadJob>()
    private val awaitingAck = ConcurrentHashMap<String, Job>()
    private val stateLock = Any()
    private var restored = false

    @Volatile
    private var reactContext: ReactApplicationContext? = null
    private val keepAliveLock = Any()
    private var keepAliveTaskId: Int? = null

    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    fun attachReactContext(context: ReactApplicationContext) {
        reactContext = context
        restore()
        engineScope.launch { resumeInterrupted() }
        if (activeUploads.isNotEmpty() || awaitingAck.isNotEmpty()) {
            acquireJsKeepAlive()
        }
    }

    fun detachReactContext(context: ReactApplicationContext) {
        synchronized(keepAliveLock) {
            keepAliveTaskId = null
        }
        if (reactContext === context) {
            reactContext = null
        }
    }

    private fun isJsAlive(): Boolean = reactContext?.hasActiveReactInstance() == true

    private fun emitEvent(eventName: String, params: WritableMap) {
        val context = reactContext ?: return
        if (!context.hasActiveReactInstance()) return
        try {
            context.getJSModule(RCTDeviceEventEmitter::class.java)?.emit(eventName, params)
        } catch (e: Exception) {
            Log.e(TAG, "Error emitting event $eventName: ${e.message}")
        }
    }

    private fun acquireJsKeepAlive() {
        UiThreadUtil.runOnUiThread {
            synchronized(keepAliveLock) {
                val context = reactContext
                if (keepAliveTaskId != null || context == null || !context.hasActiveReactInstance()) return@runOnUiThread
                val config = HeadlessJsTaskConfig(KEEP_ALIVE_TASK, Arguments.createMap(), 0, true)
                keepAliveTaskId = HeadlessJsTaskContext.getInstance(context).startTask(config)
            }
        }
    }

    private fun releaseJsKeepAlive() {
        UiThreadUtil.runOnUiThread {
            synchronized(keepAliveLock) {
                val context = reactContext
                val taskId = keepAliveTaskId ?: return@runOnUiThread
                keepAliveTaskId = null
                if (context != null && context.hasActiveReactInstance()) {
                    HeadlessJsTaskContext.getInstance(context).finishTask(taskId)
                }
            }
        }
    }

    private fun stopServiceIfIdle() {
        if (activeUploads.isEmpty() && awaitingAck.isEmpty()) {
            releaseJsKeepAlive()
            MultipartUploadService.stop(appContext)
        }
    }

    private fun holdServiceUntilAcknowledged(uploadId: String, graceMs: Long) {
        awaitingAck.remove(uploadId)?.cancel()
        awaitingAck[uploadId] = ackScope.launch {
            delay(graceMs)
            awaitingAck.remove(uploadId)
            stopServiceIfIdle()
        }
    }

    fun acknowledgeUpload(uploadId: String): Boolean {
        var acknowledged = false
        val record = records[uploadId]
        if (record != null && record.status != STATUS_RUNNING) {
            records.remove(uploadId)
            persist()
            acknowledged = true
        }
        val timer = awaitingAck.remove(uploadId)
        if (timer != null) {
            timer.cancel()
            acknowledged = true
        }
        stopServiceIfIdle()
        return acknowledged
    }

    fun pendingUploads(): WritableArray {
        restore()
        val list = Arguments.createArray()
        records.values.forEach { record ->
            val bytes = record.bytesUploaded()
            val map = Arguments.createMap()
            map.putString("uploadId", record.params.uploadId)
            map.putString("status", record.status)
            map.putDouble("progress", if (record.totalBytes > 0) bytes.toDouble() / record.totalBytes.toDouble() else 1.0)
            map.putDouble("bytesUploaded", bytes.toDouble())
            map.putDouble("totalBytes", record.totalBytes.toDouble())
            map.putArray("etags", etagsArray(record.etags.toList()))
            if (record.error != null) map.putString("error", record.error) else map.putNull("error")
            list.pushMap(map)
        }
        return list
    }

    fun completionPayload(uploadId: String): WritableMap? {
        val record = records[uploadId] ?: return null
        val map = Arguments.createMap()
        map.putString("uploadId", uploadId)
        map.putString("status", record.status)
        map.putArray("etags", etagsArray(record.etags.toList()))
        if (record.error != null) map.putString("error", record.error) else map.putNull("error")
        return map
    }

    private fun etagsArray(etags: List<String>): WritableArray {
        val array = Arguments.createArray()
        etags.forEach { array.pushString(it) }
        return array
    }

    private fun persist() {
        synchronized(stateLock) {
            try {
                val array = JSONArray()
                records.values.forEach { record ->
                    array.put(JSONObject().apply {
                        put("params", record.params.toJson())
                        put("totalBytes", record.totalBytes)
                        put("chunkSize", record.chunkSize)
                        put("etags", JSONArray(record.etags.toList()))
                        put("status", record.status)
                        put("error", record.error ?: JSONObject.NULL)
                    })
                }
                val target = File(appContext.filesDir, STATE_FILE)
                val temp = File(appContext.filesDir, "$STATE_FILE.tmp")
                temp.writeText(array.toString())
                if (!temp.renameTo(target)) {
                    target.writeText(array.toString())
                    temp.delete()
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to persist upload state: ${e.message}")
            }
        }
    }

    private fun restore() {
        synchronized(stateLock) {
            if (restored) return
            restored = true
            try {
                val file = File(appContext.filesDir, STATE_FILE)
                if (!file.exists()) return
                val array = JSONArray(file.readText())
                for (i in 0 until array.length()) {
                    val json = array.getJSONObject(i)
                    val etagsJson = json.getJSONArray("etags")
                    val etags = Array(etagsJson.length()) { etagsJson.getString(it) }
                    val params = UploadParams.fromJson(json.getJSONObject("params"), emptyList())
                    val error = if (json.isNull("error")) null else json.getString("error")
                    records[params.uploadId] = Record(
                        params,
                        json.getLong("totalBytes"),
                        json.getLong("chunkSize"),
                        etags,
                        json.getString("status"),
                        error
                    )
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to restore upload state: ${e.message}")
            }
        }
    }

    fun resumeInterrupted(): List<UploadParams> {
        restore()
        val resumed = mutableListOf<UploadParams>()
        for (record in records.values.toList()) {
            if (record.status == STATUS_RUNNING && !activeUploads.containsKey(record.params.uploadId)) {
                val params = record.params.copy(existingEtags = record.etags.toList())
                try {
                    launchUpload(params, null)
                    resumed.add(params)
                } catch (e: UploadAlreadyExistsException) {
                    continue
                } catch (e: Exception) {
                    Log.w(TAG, "Could not resume ${params.uploadId}: ${e.message}")
                    record.status = STATUS_FAILED
                    record.error = e.message
                    persist()
                    notifyFinished(record)
                }
            }
        }
        return resumed
    }

    suspend fun startMultipartUpload(params: UploadParams): WritableMap {
        val deferred = CompletableDeferred<WritableMap>()
        withContext(Dispatchers.IO) { launchUpload(params, deferred) }
        return deferred.await()
    }

    private fun launchUpload(params: UploadParams, deferred: CompletableDeferred<WritableMap>?) {
        restore()
        val file = File(params.path)
        if (!file.exists() || !file.isFile) {
            throw IllegalArgumentException("File does not exist at path: ${params.path}")
        }

        val partsCount = params.parts.size
        val fileSize = file.length()
        if (fileSize <= 0) {
            throw IllegalArgumentException("File is empty or invalid: ${params.path}")
        }

        val minRequiredSize = MIN_CHUNK_SIZE * (partsCount - 1)
        if (partsCount > 1 && fileSize <= minRequiredSize) {
            throw IllegalArgumentException(
                "File size ($fileSize bytes) is too small for $partsCount parts. Minimum required size: " + (minRequiredSize + 1) + " bytes."
            )
        }

        val chunkSize = Math.max(Math.ceil(fileSize.toDouble() / partsCount).toLong(), MIN_CHUNK_SIZE)

        val initialEtags = ConcurrentHashMap<Int, String>()
        val etagArray = Array(partsCount) { "" }
        var initialUploadedBytes = 0L
        var initialCompleted = 0L
        val count = Math.min(params.existingEtags.size, partsCount)
        for (i in 0 until count) {
            val etag = params.existingEtags[i]
            if (etag.isNotEmpty()) {
                val size = if (i == partsCount - 1) fileSize - i * chunkSize else chunkSize
                initialEtags[i + 1] = etag
                etagArray[i] = etag
                initialUploadedBytes += size
                initialCompleted++
            }
        }

        val uploadJob = UploadJob(
            uploadId = params.uploadId,
            totalBytes = fileSize,
            partsCount = partsCount,
            bytesUploaded = AtomicLong(initialUploadedBytes),
            completedChunks = AtomicLong(initialCompleted),
            partETags = initialEtags
        )
        if (activeUploads.putIfAbsent(params.uploadId, uploadJob) != null) {
            throw UploadAlreadyExistsException("Upload already in progress for ${params.uploadId}")
        }
        awaitingAck.remove(params.uploadId)?.cancel()

        val record = Record(params, fileSize, chunkSize, etagArray, STATUS_RUNNING, null)
        records[params.uploadId] = record
        persist()

        acquireJsKeepAlive()
        if (params.notificationEnabled) {
            val startMsg = if (initialUploadedBytes > 0) params.resumeMessage else params.startMessage
            MultipartUploadService.start(appContext, params.title, startMsg, params.channelName)
        }

        if (initialUploadedBytes > 0) {
            emitEvent("RNFileUploader-multipart-progress", progressMap(uploadJob, (initialCompleted - 1).toInt(), null))
        }

        val parts = params.parts.mapIndexed { index, url ->
            val offset = index * chunkSize
            val size = if (index == partsCount - 1) fileSize - offset else chunkSize
            if (size <= 0) {
                activeUploads.remove(params.uploadId, uploadJob)
                records.remove(params.uploadId)
                persist()
                throw IllegalArgumentException(
                    "Part ${index + 1} has invalid size ($size bytes). Offset: $offset, FileSize: $fileSize"
                )
            }
            PartInfo(index + 1, url, offset, size)
        }

        val job = engineScope.launch(start = CoroutineStart.LAZY) {
            try {
                coroutineScope {
                    val semaphore = Semaphore(params.maxParallel)
                    parts.map { part ->
                        async {
                            semaphore.withPermit {
                                uploadPart(file, part, uploadJob, record)
                            }
                        }
                    }.awaitAll()
                }

                if (uploadJob.completedChunks.get() < partsCount) {
                    throw Exception("Upload incomplete: completed ${uploadJob.completedChunks.get()} of $partsCount chunks")
                }

                record.status = STATUS_COMPLETED
                record.error = null
                persist()

                val result = Arguments.createMap()
                result.putString("uploadId", params.uploadId)
                result.putBoolean("success", true)
                result.putArray("etags", etagsArray(record.etags.toList()))
                deferred?.complete(result)
                notifyFinished(record)
            } catch (e: CancellationException) {
                if (uploadJob.cancelledByUser) {
                    records.remove(params.uploadId)
                    persist()
                    val cancelParams = Arguments.createMap()
                    cancelParams.putString("uploadId", params.uploadId)
                    cancelParams.putString("error", "Upload cancelled")
                    emitEvent("RNFileUploader-multipart-cancelled", cancelParams)
                } else {
                    record.status = STATUS_FAILED
                    record.error = e.message ?: "Upload cancelled"
                    persist()
                    notifyFinished(record)
                }
                deferred?.completeExceptionally(e)
            } catch (e: Exception) {
                Log.e(TAG, "Multipart upload failed for ${params.uploadId}: ${e.message}", e)
                record.status = STATUS_FAILED
                record.error = e.message ?: "Upload failed"
                persist()
                notifyFinished(record)
                deferred?.completeExceptionally(e)
            } finally {
                activeUploads.remove(params.uploadId, uploadJob)
                if (!uploadJob.cancelledByUser) {
                    holdServiceUntilAcknowledged(
                        params.uploadId,
                        if (isJsAlive()) ACK_GRACE_MS else HEADLESS_ACK_GRACE_MS
                    )
                }
                stopServiceIfIdle()
            }
        }
        uploadJob.job = job
        job.start()
    }

    private fun notifyFinished(record: Record) {
        if (isJsAlive()) {
            val params = Arguments.createMap()
            params.putString("uploadId", record.params.uploadId)
            params.putArray("etags", etagsArray(record.etags.toList()))
            if (record.status == STATUS_COMPLETED) {
                params.putBoolean("success", true)
                emitEvent("RNFileUploader-multipart-completed", params)
            } else {
                params.putString("error", record.error ?: "Upload failed")
                emitEvent("RNFileUploader-multipart-error", params)
            }
        } else {
            MultipartCompletionService.start(appContext, record.params.uploadId)
        }
    }

    private fun progressMap(uploadJob: UploadJob, chunkIndex: Int, etag: String?): WritableMap {
        val progress = if (uploadJob.totalBytes > 0) {
            uploadJob.bytesUploaded.get().toDouble() / uploadJob.totalBytes.toDouble()
        } else 1.0
        val map = Arguments.createMap()
        map.putString("uploadId", uploadJob.uploadId)
        map.putDouble("progress", progress)
        map.putDouble("bytesUploaded", uploadJob.bytesUploaded.get().toDouble())
        map.putDouble("totalBytes", uploadJob.totalBytes.toDouble())
        map.putInt("chunkIndex", chunkIndex)
        if (etag != null) map.putString("etag", etag)
        val etags = Arguments.createArray()
        for (i in 0 until uploadJob.partsCount) {
            etags.pushString(uploadJob.partETags[i + 1] ?: "")
        }
        map.putArray("etags", etags)
        return map
    }

    private suspend fun uploadPart(
        file: File,
        part: PartInfo,
        uploadJob: UploadJob,
        record: Record
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

            if (!isActive) {
                throw CancellationException("Upload cancelled")
            }

            try {
                if (!file.exists()) {
                    uploadJob.cancel()
                    throw CancellationException("Upload cancelled: file deleted")
                }

                val mediaType = "application/octet-stream".toMediaTypeOrNull()
                val request = Request.Builder()
                    .url(part.url)
                    .put(FileRegionBody(file, part.offset, part.size, mediaType))
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
                        record.etags = Array(uploadJob.partsCount) { i -> uploadJob.partETags[i + 1] ?: "" }
                        persist()
                    }
                }

                emitEvent("RNFileUploader-multipart-progress", progressMap(uploadJob, part.partNumber - 1, etag))

                if (record.params.notificationEnabled) {
                    val percent = (uploadJob.bytesUploaded.get().toDouble() / uploadJob.totalBytes.toDouble() * 100).toInt()
                    MultipartUploadService.updateProgress(
                        appContext,
                        record.params.title,
                        percent,
                        record.params.progressMessage.replace("{progress}", percent.toString())
                    )
                }

                return@withContext true
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (e is java.io.FileNotFoundException || !file.exists()) {
                    uploadJob.cancel()
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

    fun cancelUpload(uploadId: String): Boolean {
        val uploadJob = activeUploads[uploadId] ?: return false
        uploadJob.cancelledByUser = true
        uploadJob.cancel()
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
