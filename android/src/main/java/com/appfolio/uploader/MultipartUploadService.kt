package com.appfolio.uploader

import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat

class MultipartUploadService : Service() {
    companion object {
        private const val TAG = "MultipartUploadService"
        private const val CHANNEL_ID = "BackgroundUploadChannel"
        private const val NOTIFICATION_ID = 1002

        @Volatile
        var instance: MultipartUploadService? = null

        const val ACTION_START = "com.appfolio.uploader.START_FOREGROUND_UPLOAD"
        const val ACTION_STOP = "com.appfolio.uploader.STOP_FOREGROUND_UPLOAD"

        const val EXTRA_TITLE = "extra_title"
        const val EXTRA_MESSAGE = "extra_message"

        private fun isAppInForeground(context: Context): Boolean {
            val state = ActivityManager.RunningAppProcessInfo()
            ActivityManager.getMyMemoryState(state)
            return state.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE
        }

        fun ensureChannel(context: Context, channelName: String) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
                val channel = NotificationChannel(CHANNEL_ID, channelName, NotificationManager.IMPORTANCE_LOW)
                manager?.createNotificationChannel(channel)
            }
        }

        fun start(context: Context, title: String, message: String, channelName: String) {
            if (!isAppInForeground(context)) {
                Log.w(TAG, "App is not in the foreground, uploading without a foreground service")
                return
            }
            try {
                ensureChannel(context, channelName)
                val intent = Intent(context, MultipartUploadService::class.java).apply {
                    action = ACTION_START
                    putExtra(EXTRA_TITLE, title)
                    putExtra(EXTRA_MESSAGE, message)
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            } catch (e: Exception) {
                // If Android OS blocks startForegroundService (e.g. ForegroundServiceStartNotAllowedException),
                // catch it so the app process does not crash. The coroutine will still run in process.
                Log.w(TAG, "Could not start MultipartUploadService: ${e.message}")
            }
        }

        fun updateProgress(context: Context, title: String, progress: Int, message: String) {
            if (instance == null) return
            try {
                val notification = buildNotification(context, title, progress, message, ongoing = true)
                val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
                manager?.notify(NOTIFICATION_ID, notification)
            } catch (e: Exception) {
                Log.w(TAG, "Could not update progress: ${e.message}")
            }
        }

        fun stop(context: Context) {
            try {
                instance?.stopForegroundAndSelf()
                val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
                notificationManager?.cancel(NOTIFICATION_ID)
            } catch (e: Exception) {
                Log.w(TAG, "Could not stop MultipartUploadService: ${e.message}")
            }
        }

        private fun buildNotification(context: Context, title: String, progress: Int, message: String, ongoing: Boolean): Notification {
            val builder = NotificationCompat.Builder(context, CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(message)
                .setSmallIcon(android.R.drawable.stat_sys_upload)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(ongoing)
                .setAutoCancel(!ongoing)

            if (progress in 0..100) {
                builder.setProgress(100, progress, false)
            } else {
                builder.setProgress(0, 0, true)
            }

            return builder.build()
        }
    }

    private val binder = LocalBinder()
    private var isStarted = false
    private var notificationManager: NotificationManager? = null

    inner class LocalBinder : Binder() {
        fun getService(): MultipartUploadService = this@MultipartUploadService
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val title = intent.getStringExtra(EXTRA_TITLE) ?: ""
                val message = intent.getStringExtra(EXTRA_MESSAGE) ?: ""
                try {
                    startForegroundWithNotification(title, 0, message)
                } catch (e: Exception) {
                    Log.e(TAG, "Failed startForeground in onStartCommand: ${e.message}")
                    // Stop service if foreground transition was denied to prevent ANR / crash
                    stopSelf()
                }
            }
            ACTION_STOP -> {
                stopForegroundAndSelf()
            }
        }
        return START_NOT_STICKY
    }

    private fun startForegroundWithNotification(title: String, progress: Int, message: String) {
        val notification = buildNotification(this, title, progress, message, ongoing = true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        isStarted = true
    }

    fun stopForegroundAndSelf() {
        isStarted = false
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(true)
            }
            notificationManager?.cancel(NOTIFICATION_ID)
        } catch (e: Exception) {
            Log.w(TAG, "Error in stopForeground: ${e.message}")
        } finally {
            stopSelf()
        }
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        stopForegroundAndSelf()
    }

    override fun onDestroy() {
        if (instance === this) {
            instance = null
        }
        stopForegroundAndSelf()
        super.onDestroy()
    }
}
