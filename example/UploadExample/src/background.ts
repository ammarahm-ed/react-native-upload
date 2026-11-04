import RNFS from 'react-native-fs';
import Upload, { canSuspendIfBackground } from '@ammarahmed/react-native-upload';
import { S3Session, completeS3Upload } from './api';

const sessionPath = (uploadId: string) => `${RNFS.DocumentDirectoryPath}/s3-session-${uploadId}.json`;

type Stored = { base: string; session: S3Session; md5: string };

export const saveSession = (stored: Stored) =>
  RNFS.writeFile(sessionPath(stored.session.uploadId), JSON.stringify(stored), 'utf8');

const inFlight = new Map<string, Promise<void>>();

export const finalize = (
  uploadId: string,
  report: (line: string) => void,
): Promise<void> => {
  const existing = inFlight.get(uploadId);
  if (existing) return existing;
  const run = (async () => {
    try {
      if (!(await RNFS.exists(sessionPath(uploadId)))) return;
      const stored: Stored = JSON.parse(await RNFS.readFile(sessionPath(uploadId), 'utf8'));
      const pending = (await Upload.getMultipartS3Uploads()).find(u => u.uploadId === uploadId);
      if (!pending) return;
      if (pending.status !== 'completed') {
        report(`finalize ${uploadId}: status ${pending.status}`);
        return;
      }
      const done = await completeS3Upload(stored.base, stored.session, pending.etags);
      report(
        `FINALIZED ${uploadId} md5 ${done.md5} ${done.md5 === stored.md5 ? 'MD5 MATCH' : 'MD5 MISMATCH'}`,
      );
      await Upload.acknowledgeMultipartS3(uploadId);
      await RNFS.unlink(sessionPath(uploadId));
    } catch (e: any) {
      report(`finalize ${uploadId} failed: ${e.message}`);
    } finally {
      inFlight.delete(uploadId);
      canSuspendIfBackground();
    }
  })();
  inFlight.set(uploadId, run);
  return run;
};

export const attachBackgroundCompletion = (report: (line: string) => void) => {
  const sub = Upload.addMultipartListener('completed', '', data => {
    finalize(data.uploadId, report);
  });
  Upload.getMultipartS3Uploads()
    .then(list => {
      report(`pending uploads on launch: ${JSON.stringify(list.map(u => [u.uploadId, u.status]))}`);
      list.forEach(u => {
        if (u.status === 'completed') finalize(u.uploadId, report);
      });
    })
    .catch(e => report(`pending lookup failed: ${e.message}`));
  return () => sub.remove();
};
