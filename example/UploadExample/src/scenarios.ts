import Upload from '@ammarahmed/react-native-upload';
import { completeS3Upload, createS3Upload, formUrl, rawUrl, Failure } from './api';
import { generateFile } from './files';
import { saveSession } from './background';

type Result = { name: string; ok: boolean; detail: string };
type File = { path: string; size: number; md5: string };

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const runMultipart = async (
  base: string,
  file: File,
  opts: {
    parts: number;
    maxParallel?: number;
    failure?: Failure;
    failPart?: number;
    delay?: number;
    onProgress?: (p: number, etags: string[]) => void;
    session?: Awaited<ReturnType<typeof createS3Upload>>;
    existingEtags?: string[];
    hook?: (upload: ReturnType<typeof Upload.createMultipartS3>) => void;
  },
) => {
  const session = opts.session ?? (await createS3Upload(base, opts.parts, opts.failure ?? null, opts.failPart ?? 2, opts.delay));
  const upload = Upload.createMultipartS3({
    uploadId: session.uploadId,
    path: file.path,
    parts: session.urls,
    maxParallel: opts.maxParallel ?? 3,
    existingEtags: opts.existingEtags,
  });
  let etags: string[] = opts.existingEtags ?? [];
  upload.onProgress(e => {
    if (e.etags) etags = e.etags;
    opts.onProgress?.(e.progress ?? 0, etags);
  });
  opts.hook?.(upload);
  const promise = upload.start();
  return { session, upload, promise, getEtags: () => etags };
};

export const runAll = async (
  base: string,
  report: (line: string) => void,
): Promise<Result[]> => {
  const results: Result[] = [];
  const record = (name: string, ok: boolean, detail: string) => {
    results.push({ name, ok, detail });
    report(`${ok ? 'PASS' : 'FAIL'} ${name} - ${detail}`);
  };
  const scenario = async (name: string, fn: () => Promise<string>) => {
    try {
      record(name, true, await fn());
    } catch (e: any) {
      record(name, false, `${e.code ?? ''} ${e.message ?? e}`);
    }
  };
  const expect = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(msg);
  };

  const file = await generateFile(25);
  report(`file ${file.size} bytes md5 ${file.md5}`);

  await scenario('simple raw upload', async () => {
    const res = await Upload.create({
      url: rawUrl(base, null),
      path: `file://${file.path}`,
      method: 'POST',
      type: 'raw',
      headers: { 'content-type': 'application/octet-stream' },
    }).start();
    expect(res.status === 'completed', `status ${res.status} ${res.error}`);
    const body = JSON.parse(res.responseBody ?? '{}');
    expect(body.md5 === file.md5, `md5 ${body.md5} != ${file.md5}`);
    return `md5 match, ${body.size} bytes`;
  });

  await scenario('simple form multipart upload', async () => {
    const res = await Upload.create({
      url: formUrl(base, null),
      path: `file://${file.path}`,
      method: 'POST',
      type: 'multipart',
      field: 'file',
      parameters: { note: 'hello' },
    }).start();
    expect(res.status === 'completed', `status ${res.status} ${res.error}`);
    const body = JSON.parse(res.responseBody ?? '{}');
    expect(body.size === file.size, `size ${body.size} != ${file.size}`);
    expect(body.fields?.note === 'hello', 'parameter missing');
    return `size ${body.size}, fields ${JSON.stringify(body.fields)}`;
  });

  await scenario('simple upload server 500 reports error', async () => {
    const res = await Upload.create({
      url: rawUrl(base, { status: 500, times: 1 }),
      path: `file://${file.path}`,
      method: 'POST',
      type: 'raw',
    }).start();
    expect(res.status === 'error' || res.responseCode === 500, `unexpected ${JSON.stringify(res)}`);
    return `status ${res.status} code ${res.responseCode}`;
  });

  await scenario('multipart 5 parts parallel 3', async () => {
    const t = await runMultipart(base, file, { parts: 5 });
    const result = await t.promise;
    expect(result.etags.length === 5 && result.etags.every(e => e.length > 0), `etags ${JSON.stringify(result.etags)}`);
    const done = await completeS3Upload(base, t.session, result.etags);
    expect(done.md5 === file.md5, `md5 ${done.md5} != ${file.md5}`);
    return `md5 match, ${done.size} bytes`;
  });

  await scenario('multipart retries recover from 500 x2 on part 2', async () => {
    const t = await runMultipart(base, file, { parts: 5, failure: { status: 500, times: 2 }, failPart: 2 });
    const result = await t.promise;
    const done = await completeS3Upload(base, t.session, result.etags);
    expect(done.md5 === file.md5, `md5 ${done.md5} != ${file.md5}`);
    return 'recovered, md5 match';
  });

  await scenario('multipart 403 fails fast without retries', async () => {
    const started = Date.now();
    const t = await runMultipart(base, file, { parts: 5, failure: { status: 403, times: 10 }, failPart: 2 });
    let failed = false;
    try {
      await t.promise;
    } catch {
      failed = true;
    }
    const elapsed = Date.now() - started;
    expect(failed, 'upload did not fail');
    expect(elapsed < 3500, `took ${elapsed}ms, retries were attempted`);
    return `failed in ${elapsed}ms`;
  });

  await scenario('multipart too many parts for file is rejected', async () => {
    const small = await generateFile(10);
    const session = await createS3Upload(base, 5, null, 1);
    try {
      await Upload.startMultipartS3({ uploadId: session.uploadId, path: small.path, parts: session.urls });
    } catch (e: any) {
      expect(e.code === 'INVALID_ARGUMENT', `code ${e.code}`);
      return e.message;
    }
    throw new Error('was not rejected');
  });

  await scenario('multipart missing file is rejected', async () => {
    const session = await createS3Upload(base, 2, null, 1);
    try {
      await Upload.startMultipartS3({ uploadId: session.uploadId, path: '/nonexistent/file.bin', parts: session.urls });
    } catch (e: any) {
      return `${e.code}: ${e.message}`;
    }
    throw new Error('was not rejected');
  });

  await scenario('multipart pause and resume', async () => {
    let progressAt = 0;
    let lastProgress = 0;
    const t = await runMultipart(base, file, {
      parts: 5,
      maxParallel: 1,
      delay: 1000,
      onProgress: p => {
        lastProgress = p;
        progressAt = Date.now();
      },
    });
    while (lastProgress === 0) await sleep(100);
    expect(await t.upload.pause(), 'pause returned false');
    await sleep(1500);
    const before = lastProgress;
    await sleep(3000);
    expect(lastProgress === before, `progress moved while paused ${before} -> ${lastProgress}`);
    expect(await t.upload.resume(), 'resume returned false');
    const result = await t.promise;
    const done = await completeS3Upload(base, t.session, result.etags);
    expect(done.md5 === file.md5, `md5 ${done.md5} != ${file.md5}`);
    return `paused at ${Math.round(before * 100)}%, resumed, md5 match (last progress ${progressAt > 0})`;
  });

  await scenario('multipart cancel', async () => {
    const t = await runMultipart(base, file, { parts: 5, maxParallel: 1, delay: 1000 });
    t.promise.catch(() => {});
    await sleep(150);
    expect(await t.upload.cancel(), 'cancel returned false');
    try {
      await t.promise;
    } catch (e: any) {
      expect(e.code === 'CANCELLED', `code ${e.code}`);
      return 'rejected with CANCELLED';
    }
    throw new Error('promise resolved after cancel');
  });

  await scenario('multipart resume from saved etags after failure', async () => {
    const session = await createS3Upload(base, 5, { status: 403, times: 1 }, 4);
    const first = await runMultipart(base, file, { parts: 5, maxParallel: 1, session });
    let savedEtags: string[] = [];
    try {
      await first.promise;
      throw new Error('first run should fail');
    } catch (e: any) {
      expect(e.message !== 'first run should fail', e.message);
    }
    savedEtags = first.getEtags();
    expect(savedEtags.length === 5, `etags length ${savedEtags.length}`);
    const doneCount = savedEtags.filter(e => e).length;
    expect(doneCount >= 1 && doneCount < 5, `completed parts ${doneCount}`);
    const second = await runMultipart(base, file, { parts: 5, maxParallel: 1, session, existingEtags: savedEtags });
    const result = await second.promise;
    const done = await completeS3Upload(base, session, result.etags);
    expect(done.md5 === file.md5, `md5 ${done.md5} != ${file.md5}`);
    return `resumed with ${doneCount} saved parts, md5 match`;
  });

  for (const u of await Upload.getMultipartS3Uploads()) {
    await Upload.acknowledgeMultipartS3(u.uploadId);
  }

  const passed = results.filter(r => r.ok).length;
  report(`DONE ${passed}/${results.length} passed`);
  return results;
};

export const startBackgroundUpload = async (base: string, report: (line: string) => void) => {
  const file = await generateFile(50);
  report(`bg file ${file.size} bytes md5 ${file.md5}`);
  const session = await createS3Upload(base, 5, null, 1, 6000);
  await saveSession({ base, session, md5: file.md5 });
  report(`bg upload ${session.uploadId} starting, send the app to background now`);
  Upload.createMultipartS3({
    uploadId: session.uploadId,
    path: file.path,
    parts: session.urls,
    maxParallel: 3,
  })
    .start()
    .catch(e => report(`bg upload error ${e.code} ${e.message}`));
};
