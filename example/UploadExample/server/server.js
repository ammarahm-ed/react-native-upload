const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S3rver = require('s3rver');
const {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');
const {getSignedUrl} = require('@aws-sdk/s3-request-presigner');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-example-'));
const S3_PORT = Number(process.env.S3_PORT || 4568);
const BUCKET = 'uploads';
const failCounters = new Map();

const s3Server = new S3rver({
  port: S3_PORT,
  address: '127.0.0.1',
  silent: true,
  directory: path.join(DATA_DIR, 's3'),
  configureBuckets: [{name: BUCKET, configs: []}],
});

const s3ClientFor = base =>
  new S3Client({
    region: 'us-east-1',
    endpoint: base,
    forcePathStyle: true,
    credentials: {accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER'},
  });

const proxyToS3 = (req, res, url) => {
  const target = new URL(url.href);
  target.searchParams.delete('fail');
  target.searchParams.delete('times');
  target.searchParams.delete('delay');
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: S3_PORT,
      method: req.method,
      path: target.pathname + target.search,
      headers: req.headers,
    },
    up => {
      log('s3 upstream', req.method, target.pathname, up.statusCode);
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', e => {
    log('s3 upstream error', String(e));
    json(res, 502, {error: String(e)});
  });
  req.pipe(upstream);
};

const json = (res, status, body) => {
  res.writeHead(status, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(body));
};

const log = (...args) => console.log(new Date().toISOString().slice(11, 23), ...args);

const shouldFail = (key, query) => {
  const status = Number(query.get('fail'));
  const times = Number(query.get('times') || 1);
  if (!status) return 0;
  const count = failCounters.get(key) || 0;
  if (count >= times) return 0;
  failCounters.set(key, count + 1);
  return status;
};

const readBody = req =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const drainToHash = req =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    let size = 0;
    req.on('data', c => {
      hash.update(c);
      size += c.length;
    });
    req.on('end', () => resolve({size, md5: hash.digest('hex')}));
    req.on('error', reject);
  });

const saveToFile = (req, file) =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const out = fs.createWriteStream(file);
    let size = 0;
    req.on('data', c => {
      hash.update(c);
      size += c.length;
    });
    req.pipe(out);
    out.on('finish', () => resolve({size, md5: hash.digest('hex')}));
    out.on('error', reject);
    req.on('error', reject);
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);
  const q = url.searchParams;

  try {
    if (req.method === 'GET' && url.pathname === '/autorun') {
      return json(res, 200, {run: !!process.env.AUTORUN, mode: process.env.AUTORUN});
    }

    if (req.method === 'POST' && url.pathname === '/report') {
      console.log('[app]', (await readBody(req)).toString());
      return json(res, 200, {});
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, {ok: true});
    }

    if (url.pathname === '/upload/raw' && (req.method === 'PUT' || req.method === 'POST')) {
      const status = shouldFail('raw', q);
      if (status) {
        await drainToHash(req);
        log('raw upload injected failure', status);
        return json(res, status, {error: 'injected failure'});
      }
      const result = await drainToHash(req);
      log('raw upload', result.size, result.md5);
      return json(res, 200, result);
    }

    if (url.pathname === '/upload/form' && req.method === 'POST') {
      const status = shouldFail('form', q);
      const body = await readBody(req);
      if (status) {
        log('form upload injected failure', status);
        return json(res, status, {error: 'injected failure'});
      }
      const contentType = req.headers['content-type'] || '';
      const boundary = /boundary=(.+)$/.exec(contentType);
      const text = body.toString('latin1');
      const fields = {};
      let fileSize = 0;
      if (boundary) {
        for (const section of text.split('--' + boundary[1])) {
          const header = /name="([^"]+)"(?:; filename="([^"]*)")?/.exec(section);
          if (!header) continue;
          const start = section.indexOf('\r\n\r\n');
          if (start < 0) continue;
          const content = section.slice(start + 4, section.length - 2);
          if (header[2] !== undefined) fileSize = content.length;
          else fields[header[1]] = content;
        }
      }
      log('form upload', body.length, 'file', fileSize, fields);
      return json(res, 200, {size: fileSize, bodySize: body.length, fields});
    }

    if (parts[0] === BUCKET) {
      const key = parts.slice(1).join('/');
      const status = shouldFail(`${key}:${q.get('partNumber') || ''}`, q);
      if (status) {
        req.resume();
        log('s3 injected failure', status, key, q.get('partNumber'));
        return json(res, status, {error: 'injected failure'});
      }
      const delay = Number(q.get('delay') || 0);
      if (delay) await new Promise(r => setTimeout(r, delay));
      log('s3 proxy', req.method, key, q.get('partNumber') || '');
      return proxyToS3(req, res, url);
    }

    if (req.method === 'POST' && url.pathname === '/s3/create') {
      const {base, parts: count, failPart, fail, times, delay} = JSON.parse((await readBody(req)).toString());
      const client = s3ClientFor(base);
      const internal = s3ClientFor(`http://127.0.0.1:${S3_PORT}`);
      const key = `file-${crypto.randomBytes(6).toString('hex')}.bin`;
      const created = await internal.send(new CreateMultipartUploadCommand({Bucket: BUCKET, Key: key}));
      const urls = [];
      for (let i = 1; i <= count; i++) {
        let signed = await getSignedUrl(
          client,
          new UploadPartCommand({Bucket: BUCKET, Key: key, UploadId: created.UploadId, PartNumber: i}),
          {expiresIn: 3600},
        );
        if (fail && i === failPart) signed += `&fail=${fail}&times=${times || 1}`;
        if (delay) signed += `&delay=${delay}`;
        urls.push(signed);
      }
      log('s3 create', key, created.UploadId, count, 'parts');
      return json(res, 200, {uploadId: created.UploadId, key, urls});
    }

    if (req.method === 'POST' && url.pathname === '/s3/complete') {
      const {key, uploadId, etags} = JSON.parse((await readBody(req)).toString());
      const client = s3ClientFor(`http://127.0.0.1:${S3_PORT}`);
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: BUCKET,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {Parts: etags.map((e, i) => ({PartNumber: i + 1, ETag: `"${e}"`}))},
        }),
      );
      const object = await client.send(new GetObjectCommand({Bucket: BUCKET, Key: key}));
      const hash = crypto.createHash('md5');
      let size = 0;
      for await (const chunk of object.Body) {
        hash.update(chunk);
        size += chunk.length;
      }
      const md5 = hash.digest('hex');
      log('s3 complete', key, size, md5);
      return json(res, 200, {size, md5});
    }

    json(res, 404, {error: 'not found'});
  } catch (e) {
    log('error', e);
    json(res, 500, {error: String(e)});
  }
});

s3Server.run().then(() => log(`s3rver on 127.0.0.1:${S3_PORT}, bucket "${BUCKET}"`));

server.listen(PORT, '0.0.0.0', () => {
  const addrs = Object.values(os.networkInterfaces())
    .flat()
    .filter(i => i.family === 'IPv4' && !i.internal)
    .map(i => `http://${i.address}:${PORT}`);
  log(`mock upload server on :${PORT}`);
  log('simulator: http://localhost:' + PORT + '  android emulator: http://10.0.2.2:' + PORT);
  addrs.forEach(a => log('device:', a));
});
