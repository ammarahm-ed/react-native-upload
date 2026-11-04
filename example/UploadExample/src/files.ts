import RNFS from 'react-native-fs';

const BLOCK_BYTES = 768 * 1024;
const BLOCK_CHARS = (BLOCK_BYTES / 3) * 4;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const makeBase = () => {
  let s = '';
  let seed = 12345;
  for (let i = 0; i < BLOCK_CHARS; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    s += ALPHABET[seed % 64];
  }
  return s;
};

const counterChars = (n: number) => {
  let out = '';
  for (let i = 0; i < 8; i++) {
    out = ALPHABET[n % 64] + out;
    n = Math.floor(n / 64);
  }
  return out;
};

export const generateFile = async (
  sizeMB: number,
  onProgress?: (written: number, total: number) => void,
) => {
  const path = `${RNFS.CachesDirectoryPath}/upload-test-${sizeMB}mb.bin`;
  if (await RNFS.exists(path)) await RNFS.unlink(path);
  const total = sizeMB * 1024 * 1024;
  const blocks = Math.floor(total / BLOCK_BYTES);
  const base = makeBase();
  for (let i = 0; i < blocks; i++) {
    const block = counterChars(i) + base.slice(8);
    if (i === 0) await RNFS.writeFile(path, block, 'base64');
    else await RNFS.appendFile(path, block, 'base64');
    onProgress?.((i + 1) * BLOCK_BYTES, total);
  }
  const stat = await RNFS.stat(path);
  const md5 = await RNFS.hash(path, 'md5');
  return { path, size: Number(stat.size), md5 };
};

export const hashFile = (path: string) => RNFS.hash(path, 'md5');
