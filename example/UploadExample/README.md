# UploadExample

End-to-end test app for simple (raw and form multipart) uploads and S3 multipart uploads.

## Setup

```sh
npm install
cd ios && bundle install && bundle exec pod install && cd ..
```

The library is linked from the repo root (`file:../..`) and built output comes from `dist/`. Run `npm run build` in the repo root after changing `src/`.

## Run

```sh
npm run server
npm start
npm run ios
npm run android
```

`npm run server` starts a mock server on port 3000 and a local S3 (`s3rver`) on 127.0.0.1:4568. Part URLs are real SigV4 presigned URLs, proxied through port 3000 so the app only needs one host. The server computes the md5 of the assembled object, and the app compares it to the md5 of the local file.

Server URL defaults to `http://localhost:3000` on iOS and `http://10.0.2.2:3000` on Android emulators. On a physical device enter your computer's LAN IP, printed by the server on start.

## What to test

- Raw and form multipart simple uploads, with cancel
- S3 multipart with different part counts and parallelism
- Pause, resume and cancel
- Failure injection: 500 x2 should recover through retries; 403 should fail the upload immediately
- Resume with saved ETags after a failure or cancel
- Backgrounding the app during an upload
