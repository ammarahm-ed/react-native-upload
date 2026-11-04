import RNFS from 'react-native-fs';
import Upload, { MultipartCompletionEvent } from '@ammarahmed/react-native-upload';
import { S3Session, completeS3Upload } from './api';

const sessionPath = (uploadId: string) => `${RNFS.DocumentDirectoryPath}/s3-session-${uploadId}.json`;

type Stored = { base: string; session: S3Session; md5: string };

export const saveSession = (stored: Stored) =>
  RNFS.writeFile(sessionPath(stored.session.uploadId), JSON.stringify(stored), 'utf8');

const reportTo = (base: string, line: string) =>
  fetch(`${base}/report`, { method: 'POST', body: line }).then(
    () => {},
    () => {},
  );

const inFlight = new Map<string, Promise<void>>();

export const handleCompletion = (event: MultipartCompletionEvent): Promise<void> => {
  const existing = inFlight.get(event.uploadId);
  if (existing) return existing;
  const run = (async () => {
    if (!(await RNFS.exists(sessionPath(event.uploadId)))) return;
    const stored: Stored = JSON.parse(await RNFS.readFile(sessionPath(event.uploadId), 'utf8'));
    if (event.status !== 'completed') {
      await reportTo(stored.base, `upload ${event.uploadId} failed: ${event.error}`);
      return;
    }
    const done = await completeS3Upload(stored.base, stored.session, event.etags);
    await RNFS.unlink(sessionPath(event.uploadId));
    await reportTo(
      stored.base,
      `FINALIZED ${event.uploadId} md5 ${done.md5} ${done.md5 === stored.md5 ? 'MD5 MATCH' : 'MD5 MISMATCH'}`,
    );
  })().finally(() => inFlight.delete(event.uploadId));
  inFlight.set(event.uploadId, run);
  return run;
};

export const registerBackgroundHandler = () => {
  Upload.setMultipartCompletionHandler(handleCompletion);
};

export const recoverPendingUploads = async (report: (line: string) => void) => {
  const list = await Upload.getMultipartS3Uploads();
  report(`pending uploads on launch: ${JSON.stringify(list.map(u => [u.uploadId, u.status]))}`);
  for (const u of list) {
    if (u.status === 'running') continue;
    await handleCompletion({
      uploadId: u.uploadId,
      status: u.status === 'completed' ? 'completed' : 'failed',
      etags: u.etags,
      error: u.error,
    });
    await Upload.acknowledgeMultipartS3(u.uploadId);
  }
};
