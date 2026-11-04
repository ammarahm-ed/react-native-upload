# react-native-background-upload [![npm version](https://badge.fury.io/js/react-native-background-upload.svg)](https://badge.fury.io/js/react-native-background-upload) ![GitHub Actions status](https://github.com/Vydia/react-native-background-upload/workflows/Test%20iOS%20Example%20App/badge.svg) ![GitHub Actions status](https://github.com/Vydia/react-native-background-upload/workflows/Test%20Android%20Example%20App/badge.svg) [![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)

The only React Native http post file uploader with android and iOS background support.  If you are uploading large files like videos, use this so your users can background your app during a long upload.

NOTE: Use major version 4 with RN 47.0 and greater.  If you have RN less than 47, use 3.0.  To view all available versions:
`npm show react-native-background-upload versions`


# Installation

## 1. Install package

`npm install --save react-native-background-upload`

or

`yarn add react-native-background-upload`

Note: if you are installing on React Native < 0.47, use `react-native-background-upload@3.0.0` instead of `react-native-background-upload`

## 2. Link Native Code

### Autolinking (React Native >= 0.60)

##### iOS

`cd ./ios && pod install && cd ../`

##### Android

No further actions required.

### Automatic Native Library Linking (React Native < 0.60)

`react-native link react-native-background-upload`

### Or, Manually Link It

#### iOS

1. In the XCode's "Project navigator", right click on your project's Libraries folder ➜ `Add Files to <...>`
2. Go to `node_modules` ➜ `react-native-background-upload` ➜ `ios` ➜ select `VydiaRNFileUploader.xcodeproj`
3. Add `VydiaRNFileUploader.a` to `Build Phases -> Link Binary With Libraries`

#### Android
1. Add the following lines to `android/settings.gradle`:

    ```gradle
    include ':react-native-background-upload'
    project(':react-native-background-upload').projectDir = new File(settingsDir, '../node_modules/react-native-background-upload/android')
    ```
2. Add the compile and resolutionStrategy line to the dependencies in `android/app/build.gradle`:

    ```gradle
    configurations.all { resolutionStrategy.force 'com.squareup.okhttp3:okhttp:3.4.1' } // required by react-native-background-upload until React Native supports okhttp >= okhttp 3.5

    dependencies {
        compile project(':react-native-background-upload')
    }
    ```


3. Add the import and link the package in `MainApplication.java`:

    ```java
    import com.vydia.RNUploader.UploaderReactPackage;  <-- add this import

    public class MainApplication extends Application implements ReactApplication {
        @Override
        protected List<ReactPackage> getPackages() {
            return Arrays.<ReactPackage>asList(
                new MainReactPackage(),
                new UploaderReactPackage() // <-- add this line
            );
        }
    }
    ```

4. Ensure Android SDK versions.  Open your app's `android/app/build.gradle` file.  Ensure `compileSdkVersion` and `targetSdkVersion` are 25.  Otherwise you'll get compilation errors.

## 3. Expo

To use this library with [Expo](https://expo.io) one must first detach (eject) the project and follow [step 2](#2-link-native-code) instructions. Additionally on iOS there is a must to add a Header Search Path to other dependencies which are managed using Pods. To do so one has to add `$(SRCROOT)/../../../ios/Pods/Headers/Public` to Header Search Path in `VydiaRNFileUploader` module using XCode.

# Usage

```js
import Upload from 'react-native-background-upload'

const options = {
  url: 'https://myservice.com/path/to/post',
  path: 'file://path/to/file/on/device',
  method: 'POST',
  type: 'raw',
  maxRetries: 2, // set retry count (Android only). Default 2
  headers: {
    'content-type': 'application/octet-stream', // Customize content-type
    'my-custom-header': 's3headervalueorwhateveryouneed'
  },
  // Below are options only supported on Android
  notification: {
    enabled: true
  },
  useUtf8Charset: true
}

Upload.startUpload(options).then((uploadId) => {
  console.log('Upload started')
  Upload.addListener('progress', uploadId, (data) => {
    console.log(`Progress: ${data.progress}%`)
  })
  Upload.addListener('error', uploadId, (data) => {
    console.log(`Error: ${data.error}%`)
  })
  Upload.addListener('cancelled', uploadId, (data) => {
    console.log(`Cancelled!`)
  })
  Upload.addListener('completed', uploadId, (data) => {
    // data includes responseCode: number and responseBody: Object
    console.log('Completed!')
  })
}).catch((err) => {
  console.log('Upload error!', err)
})
```

## Multipart Uploads

Just set the `type` option to `multipart` and set the `field` option.  Example:

```
const options = {
  url: 'https://myservice.com/path/to/post',
  path: 'file://path/to/file%20on%20device.png',
  method: 'POST',
  field: 'uploaded_media',
  type: 'multipart'
}
```

Note the `field` property is required for multipart uploads.

## S3 / Cloud Multipart Upload (Chunked)

For large files (e.g. > 25MB) that need to be uploaded in chunked parts to AWS S3, Google Cloud Storage, Cloudflare R2, or MinIO using presigned URLs:

```typescript
import Upload from "@ammarahmed/react-native-upload";

const upload = Upload.createMultipartS3({
  uploadId: "unique-upload-id-123",
  path: "/path/to/large-video.mp4",
  parts: [
    "https://s3.amazonaws.com/bucket/file?partNumber=1&uploadId=...",
    "https://s3.amazonaws.com/bucket/file?partNumber=2&uploadId=...",
    // ... presigned URLs for each part
  ],
  maxParallel: 3, // Optional: maximum parallel chunk uploads (default: 3)
  notification: {
    enabled: true,
    filename: "large-video.mp4", // Optional: human-readable name in notification
  },
  appGroup: "group.com.myapp", // Optional: iOS App Group for Share Extensions
});

// Track progress
upload.onProgress((event) => {
  console.log(`Uploaded ${event.bytesUploaded}/${event.totalBytes} bytes (${(event.progress * 100).toFixed(1)}%)`);
  console.log(`Current chunk index: ${event.chunkIndex}`);
});

try {
  const result = await upload.start();
  if (result.success) {
    // Array of ETags matching the order of the parts (for S3 CompleteMultipartUpload)
    console.log("Upload completed with ETags:", result.etags);
  }
} catch (error) {
  if (error.code === "CANCELLED") {
    console.log("Upload was cancelled");
  } else {
    console.error("Upload failed:", error);
  }
}

// To cancel mid-upload:
// await upload.cancel();
// or statically:
// await Upload.cancelMultipartS3("unique-upload-id-123");
```

### Resumption on Network Failure

If an upload is interrupted or network drops, you can resume by passing `existingEtags`. `onProgress` emits an `etags` array matching the parts list (with empty strings for pending parts):

```typescript
const upload = Upload.createMultipartS3({
  uploadId: savedUploadId, // Re-use the existing S3 upload ID
  path: "/path/to/large-video.mp4",
  parts: presignedUrls,
  existingEtags: savedEtags, // Fixed-length array with ETags for completed parts, "" for pending parts
});
```

### Finishing the upload in the background

An S3 multipart upload is only complete once you send `CompleteMultipartUpload` with the part ETags. To make that happen even when the app is suspended, or was killed and restarted for the upload, register a completion handler. Do it at the top level of your entry file (`index.js`), outside of any component, so it exists when the app is started in the background:

```typescript
import Upload from "@ammarahmed/react-native-upload";

Upload.setMultipartCompletionHandler(async ({ uploadId, status, etags, error }) => {
  if (status !== "completed") return;
  // Load whatever you saved when you started the upload (bucket, key, ...)
  await completeMultipartUpload(uploadId, etags);
});
```

- The handler is called when every part has been uploaded (or the upload failed). When it resolves, the upload is acknowledged and its stored state is removed. If it throws, the upload is not acknowledged and stays pending.
- It is called while the app is running and, on Android, from a headless JS task when the app process was not running. Save what you need to finish the upload (for example the S3 key) to storage before starting it; the headless task starts your JS bundle from scratch.
- If you use the handler, don't also finish the upload from the `start()` promise.
- Fallback: completed uploads are persisted natively. If the handler could not run, check on every app launch and finish them without uploading again:

```typescript
const pending = await Upload.getMultipartS3Uploads();
for (const upload of pending) {
  if (upload.status === "completed") {
    await completeMultipartUpload(upload.uploadId, upload.etags);
    await Upload.acknowledgeMultipartS3(upload.uploadId);
  }
}
```

`status` is `running`, `completed` or `failed`. A failed upload keeps its `etags`, so you can start it again with `existingEtags`.

### iOS Background Behavior

All multipart uploads share one background `NSURLSession`. Every part is queued when the upload starts, so iOS keeps uploading while the app is suspended and wakes the app when parts finish. Upload state is persisted and reattached when the app is relaunched.

Forward the system's background session event to the library in your `AppDelegate`:

```swift
func application(
  _ application: UIApplication,
  handleEventsForBackgroundURLSession identifier: String,
  completionHandler: @escaping () -> Void
) {
  RNFileUploader.setCompletionHandlerWithIdentifier(identifier, completionHandler: completionHandler)
}
```

(With Swift, import the library header in your bridging header: `#import <react-native-upload/RNFileUploader.h>`.)

Notes:
- The system completion handler is released when your JS calls `canSuspendIfBackground()`, which the library calls after the handler runs. Keep the handler short, iOS gives the app limited time when it wakes it.
- Chunk files are written to a copy in Application Support (or the App Group container when `appGroup` is set) until the upload ends, so you need free space for a second copy of the file.
- If the user force-quits the app, iOS cancels the background transfers. Resume with `existingEtags`.

### Android Foreground Service and Headless Task

Background support on Android is opt-in. The library does not add any permissions or services to your app. Add the following to your app's `AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

<application>
  <service
    android:name="com.appfolio.uploader.MultipartUploadService"
    android:exported="false"
    android:foregroundServiceType="dataSync" />
  <service
    android:name="com.appfolio.uploader.MultipartCompletionService"
    android:exported="false" />
</application>
```

How it works:
- Uploads run in a native engine that is independent of your Activity and of the React instance. State (part URLs, ETags, status) is saved to disk after every part.
- With `notification.enabled` the engine runs a foreground service, which also keeps your JS timers running while the app is in the background.
- If the system restarts the service after killing the app's process, the engine resumes the remaining parts on its own.
- When an upload finishes and no React instance is running, `MultipartCompletionService` starts a headless JS task that runs your completion handler.
- After an upload ends, the service stays alive until the handler resolves (or `Upload.acknowledgeMultipartS3(uploadId)` is called), or for 30 seconds, or 2 minutes if the headless task was started.

Notes:
- Google Play requires a declaration for `FOREGROUND_SERVICE_DATA_SYNC`.
- `POST_NOTIFICATIONS` must be requested at runtime on Android 13+ for the notification to appear.
- The foreground service is only started while your app is in the foreground. Without it, the process can still be killed by the system, and uploads are then resumed the next time the app starts.
- A force stop or an OEM that kills the app when it is removed from recents does not restart the service. The persisted uploads resume the next time the app is opened, and completed ones can be finished with `getMultipartS3Uploads()` as shown above.
- On Android 15+ `dataSync` services have a time limit; the service stops itself when the system times it out.
- The library compiles against `compileSdkVersion` 35 or higher.
- Notification texts can be customized with `onProgressTitle`, `onStartMessage`, `onResumeMessage`, `onProgressMessage` (use `{progress}` for the percentage) and `notificationChannelName`.

# API

## Top Level Functions

All top-level methods are available as named exports or methods on the default export.

### startUpload(options)

The primary method you will use, this starts the upload process.

Returns a promise with the string ID of the upload.  Will reject if there is a connection problem, the file doesn't exist, or there is some other problem.

`options` is an object with following values:

*Note: You must provide valid URIs. react-native-background-upload does not escape the values you provide.*

|Name|Type|Required|Default|Description|Example|
|---|---|---|---|---|---|
|`url`|string|Required||URL to upload to|`https://myservice.com/path/to/post`|
|`path`|string|Required||File path on device|`file://something/coming/from%20the%20device.png`|
|`type`|'raw' or 'multipart'|Optional|`raw`|Primary upload type.||
|`method`|string|Optional|`POST`|HTTP method||
|`customUploadId`|string|Optional||`startUpload` returns a Promise that includes the upload ID, which can be used for future status checks.  By default, the upload ID is automatically generated.  This parameter allows a custom ID to use instead of the default.||
|`headers`|object|Optional||HTTP headers|`{ 'Accept': 'application/json' }`|
|`field`|string|Required if `type: 'multipart'`||The form field name for the file.  Only used when `type: 'multipart`|`uploaded-file`|
|`parameters`|object|Optional||Additional form fields to include in the HTTP request. Only used when `type: 'multipart`||
|`notification`|Notification object (see below)|Optional||Android only.  |`{ enabled: true, onProgressTitle: "Uploading...", autoClear: true }`|
|`useUtf8Charset`|boolean|Optional||Android only. Set to true to use `utf-8` as charset. ||
|`appGroup`|string|Optional|iOS only. App group ID needed for share extensions to be able to properly call the library. See: https://developer.apple.com/documentation/foundation/nsfilemanager/1412643-containerurlforsecurityapplicati

### Notification Object (Android Only)
|Name|Type|Required|Description|Example|
|---|---|---|---|---|
|`enabled`|boolean|Optional|Enable or diasable notifications. Works only on Android version < 8.0 Oreo. On Android versions >= 8.0 Oreo is required by Google's policy to display a notification when a background service run|`{ enabled: true }`|
|`autoClear`|boolean|Optional|Autoclear notification on complete|`{ autoclear: true }`|
|`notificationChannel`|string|Optional|Sets android notificaion channel|`{ notificationChannel: "My-Upload-Service" }`|
|`enableRingTone`|boolean|Optional|Sets whether or not to enable the notification sound when the upload gets completed with success or error|`{ enableRingTone: true }`|
|`onProgressTitle`|string|Optional|Sets notification progress title|`{ onProgressTitle: "Uploading" }`|
|`onProgressMessage`|string|Optional|Sets notification progress message|`{ onProgressMessage: "Uploading new video" }`|
|`onCompleteTitle`|string|Optional|Sets notification complete title|`{ onCompleteTitle: "Upload finished" }`|
|`onCompleteMessage`|string|Optional|Sets notification complete message|`{ onCompleteMessage: "Your video has been uploaded" }`|
|`onErrorTitle`|string|Optional|Sets notification error title|`{ onErrorTitle: "Upload error" }`|
|`onErrorMessage`|string|Optional|Sets notification error message|`{ onErrorMessage: "An error occured while uploading a video" }`|
|`onCancelledTitle`|string|Optional|Sets notification cancelled title|`{ onCancelledTitle: "Upload cancelled" }`|
|`onCancelledMessage`|string|Optional|Sets notification cancelled message|`{ onCancelledMessage: "Video upload was cancelled" }`|


### getFileInfo(path)

Returns some useful information about the file in question.  Useful if you want to set a MIME type header.

`path` is a string, such as `file://path.to.the.file.png`

Returns a Promise that resolves to an object containing:

|Name|Type|Required|Description|Example|
|---|---|---|---|---|
|`name`|string|Required|The file name within its directory.|`image2.png`|
|`exists`|boolean|Required|Is there a file matching this path?||
|`size`|number|If `exists`|File size, in bytes||
|`extension`|string|If `exists`|File extension|`mov`|
|`mimeType`|string|If `exists`|The MIME type for the file.|`video/mp4`|

### cancelUpload(uploadId)

Cancels an upload.

`uploadId` is the result of the Promise returned from `startUpload`

Returns a Promise that resolves to an boolean indicating whether the upload was cancelled.

### addListener(eventType, uploadId, listener)

Adds an event listener, possibly confined to a single upload.

`eventType` Event to listen for. Values: 'progress' | 'error' | 'completed' | 'cancelled'

`uploadId` The upload ID from `startUpload` to filter events for.  If null, this will include all uploads.

`listener` Function to call when the event occurs.

Returns an [EventSubscription](https://github.com/facebook/react-native/blob/master/Libraries/vendor/emitter/EmitterSubscription.js). To remove the listener, call `remove()` on the `EventSubscription`.

### shouldLimitNetwork(limit)

`limit` boolean, sets whether or not to limit network usage.

On Android, this setting takes effect immediately and will be applied for the next upload. On iOS, this setting will be only applied for the next NSURLSession.

### getAllUploads()

Retrieves all scheduled uploads and their state from system's internal database.

Note that this will not give you all the uploads ever scheduled, both iOS and Android periodically prune completed(succeeded/failed/cancelled) tasks from their database. Therefore this should not be used as the primary way to check upload statuses, add your listeners via `addListener` instead. However, `getAllUploads` is particularly useful as a backup plan in case events were dropped(e.g. adding listeners too late).

Returns a Promise that resolves to an array of objects containing:

|Name|Type|Required|Description|
|---|---|---|---|
|`id`|string|Required|The upload ID from `startUpload`|
|`state`|[UploadState](#uploadstate)|Required|The current state of the upload|

## Events

### progress

Event Data

|Name|Type|Required|Description|
|---|---|---|---|
|`id`|string|Required|The ID of the upload.|
|`progress`|0-100|Required|Percentage completed.|

### error

Event Data

|Name|Type|Required|Description|
|---|---|---|---|
|`id`|string|Required|The ID of the upload.|
|`error`|string|Required|Error message.|

### completed

Event Data

|Name|Type|Required|Description|
|---|---|---|---|
|`id`|string|Required|The ID of the upload.|
|`responseCode`|string|Required|HTTP status code received|
|`responseBody`|string|Required|HTTP response body|

### cancelled

Event Data

|Name|Type|Required|Description|
|---|---|---|---|
|`id`|string|Required|The ID of the upload.|

## Types

### UploadState

|Value|Description|
|---|---|
|`cancelled`|The upload has been cancelled, either by OS or by using `cancelUpload`|
|`completed`|The upload has finished, either succeeded or failed|
|`pending`|The upload is scheduled but not active at the moment|
|`running`|The upload is in progress|

# Customizing Android Build Properties
You may want to customize the `compileSdk, buildToolsVersion, and targetSdkVersion` versions used by this package.  For that, add this to `android/build.gradle`:

```
ext {
    targetSdkVersion = 23
    compileSdkVersion = 23
    buildToolsVersion = '23.0.2'
}
```

Add it above `allProjects` and you're good.  Your `android/build.gradle` might then resemble:
```
buildscript {
    repositories {
        jcenter()
    }
}

ext {
    targetSdkVersion = 27
    compileSdkVersion = 27
    buildToolsVersion = '23.0.2'
}

allprojects {

```

# FAQs

Is there an example/sandbox app to test out this package?

> Yes, there is a simple react native app that comes with an [express](https://github.com/expressjs/express) server where you can see react-native-background-upload in action and try things out in an isolated local environment.

[UploadExample](example/UploadExample)

Does it support iOS camera roll assets?

> Yes, as of version 4.3.0.

Does it support multiple file uploads?

> Yes and No.  It supports multiple concurrent uploads, but only a single upload per request.  That should be fine for 90%+ of cases.

Why should I use this file uploader instead of others that I've Googled like [react-native-uploader](https://github.com/aroth/react-native-uploader)?

> This package has two killer features not found anywhere else (as of 12/16/2016).  First, it works on both iOS and Android.  Others are iOS only.  Second, it supports background uploading.  This means that users can background your app and the upload will continue.  This does not happen with other uploaders.


# Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

# Common Issues

## BREAKING CHANGE IN 3.0
This is for 3.0 only.  This does NOT apply to 4.0, as recent React Native versions have upgraded the `okhttp` dependencies.  Anyway...

In 3.0, you need to add
```gradle
    configurations.all { resolutionStrategy.force 'com.squareup.okhttp3:okhttp:3.4.1' }
```
to your app's app's `android/app/build.gradle` file.

Just add it above (not within) `dependencies` and you'll be fine.


## BREAKING CHANGE IN 2.0
Two big things happened in version 2.0.  First, thehe Android package name had to be changed, as it conflicted with our own internal app.  My bad.  Second, we updated the android upload service dependency to the latest, but that requires the app have a compileSdkVersion and targetSdkVersion or 25.

To upgrade:
In `MainApplication.java`:

Change

    ```java
    import com.vydia.UploaderReactPackage;
    ```

to

    ```java
    import com.vydia.RNUploader.UploaderReactPackage;
    ```

Then open your app's `android/app/build.gradle` file.
Ensure `compileSdkVersion` and `targetSdkVersion` are 25.

Done!


## Gratitude

Thanks to:
- [android-upload-service](https://github.com/gotev/android-upload-service)  It made Android dead simple to support.

- [MIME type from path on iOS](http://stackoverflow.com/questions/2439020/wheres-the-iphone-mime-type-database)  Thanks for the answer!
