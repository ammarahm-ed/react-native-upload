package com.appfolio.uploader

import android.content.Context
import android.content.Intent
import android.util.Log
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.jstasks.HeadlessJsTaskConfig

class MultipartCompletionService : HeadlessJsTaskService() {
    companion object {
        private const val TAG = "MultipartCompletion"
        private const val TASK_KEY = "RNMultipartUploadCompletion"
        private const val TASK_TIMEOUT_MS = 120_000L
        private const val EXTRA_UPLOAD_ID = "extra_upload_id"

        fun start(context: Context, uploadId: String) {
            try {
                val intent = Intent(context, MultipartCompletionService::class.java).apply {
                    putExtra(EXTRA_UPLOAD_ID, uploadId)
                }
                context.startService(intent)
            } catch (e: Exception) {
                Log.w(TAG, "Could not start MultipartCompletionService: ${e.message}")
            }
        }
    }

    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
        val uploadId = intent?.getStringExtra(EXTRA_UPLOAD_ID) ?: return null
        val payload = MultipartUploader.getInstance(this).completionPayload(uploadId) ?: return null
        return HeadlessJsTaskConfig(TASK_KEY, payload, TASK_TIMEOUT_MS, true)
    }
}
