export type Failure = { status: number; times: number } | null;

const withFailure = (url: string, failure: Failure) =>
  failure ? `${url}${url.includes('?') ? '&' : '?'}fail=${failure.status}&times=${failure.times}` : url;

export const rawUrl = (base: string, failure: Failure) => withFailure(`${base}/upload/raw`, failure);
export const formUrl = (base: string, failure: Failure) => withFailure(`${base}/upload/form`, failure);

export type S3Session = { uploadId: string; key: string; urls: string[] };

export const createS3Upload = async (
  base: string,
  parts: number,
  failure: Failure,
  failPart: number,
): Promise<S3Session> => {
  const res = await fetch(`${base}/s3/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base,
      parts,
      failPart,
      fail: failure?.status,
      times: failure?.times,
    }),
  });
  if (!res.ok) throw new Error(`create failed: ${res.status}`);
  return res.json();
};

export const completeS3Upload = async (base: string, session: S3Session, etags: string[]) => {
  const res = await fetch(`${base}/s3/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: session.key, uploadId: session.uploadId, etags }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`complete failed: ${res.status} ${JSON.stringify(body)}`);
  return body as { size: number; md5: string };
};
