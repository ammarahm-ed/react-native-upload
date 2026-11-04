import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Upload from '@ammarahmed/react-native-upload';
import { generateFile } from './src/files';
import { runAll, startBackgroundUpload } from './src/scenarios';
import { attachBackgroundCompletion } from './src/background';
import {
  Failure,
  completeS3Upload,
  createS3Upload,
  formUrl,
  S3Session,
  rawUrl,
} from './src/api';

type TestFile = { path: string; size: number; md5: string };

const DEFAULT_BASE = Platform.OS === 'android' ? 'http://10.0.2.2:3000' : 'http://localhost:3000';
const SIZES = [10, 25, 50, 100];
const FAILURES: { label: string; value: Failure }[] = [
  { label: 'None', value: null },
  { label: '500 x2', value: { status: 500, times: 2 } },
  { label: '500 x10', value: { status: 500, times: 10 } },
  { label: '403', value: { status: 403, times: 10 } },
];

const Button = ({ title, onPress, active }: { title: string; onPress: () => void; active?: boolean }) => (
  <TouchableOpacity onPress={onPress} style={[styles.button, active && styles.buttonActive]}>
    <Text style={[styles.buttonText, active && styles.buttonTextActive]}>{title}</Text>
  </TouchableOpacity>
);

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <View style={styles.section}>
    <Text style={styles.sectionTitle}>{title}</Text>
    {children}
  </View>
);

export default function App() {
  const [base, setBase] = useState(DEFAULT_BASE);
  const [sizeMB, setSizeMB] = useState(25);
  const [file, setFile] = useState<TestFile | null>(null);
  const [parts, setParts] = useState('5');
  const [maxParallel, setMaxParallel] = useState('3');
  const [failure, setFailure] = useState<Failure>(null);
  const [failPart, setFailPart] = useState('2');
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('idle');
  const [logs, setLogs] = useState<string[]>([]);
  const simpleRef = useRef<ReturnType<typeof Upload.create> | null>(null);
  const s3Ref = useRef<S3Session | null>(null);
  const etagsRef = useRef<string[]>([]);

  const log = useCallback((line: string) => {
    setLogs(l => [`${new Date().toLocaleTimeString()} ${line}`, ...l].slice(0, 200));
  }, []);

  const generate = async () => {
    setStatus('generating file');
    setFile(null);
    try {
      const f = await generateFile(sizeMB, (w, t) => setProgress(w / t));
      setFile(f);
      log(`file ${f.size} bytes md5 ${f.md5}`);
      setStatus('idle');
    } catch (e: any) {
      log(`generate failed: ${e.message}`);
      setStatus('error');
    }
    setProgress(0);
  };

  const requireFile = () => {
    if (!file) log('generate a file first');
    return file;
  };

  const runSimple = async (type: 'raw' | 'multipart') => {
    const f = requireFile();
    if (!f) return;
    setProgress(0);
    setStatus(`simple ${type} uploading`);
    const upload = Upload.create({
      url: type === 'raw' ? rawUrl(base, failure) : formUrl(base, failure),
      path: `file://${f.path}`,
      method: 'POST',
      type,
      field: type === 'multipart' ? 'file' : undefined,
      parameters: type === 'multipart' ? { note: 'example' } : undefined,
      headers: type === 'raw' ? { 'content-type': 'application/octet-stream' } : undefined,
      notification: { enabled: true },
    });
    simpleRef.current = upload;
    upload.onChange(e => {
      if (e.progress != null) setProgress(e.progress / 100);
    });
    try {
      const res = await upload.start();
      log(`simple ${type} ${res.status} code=${res.responseCode} body=${res.responseBody ?? res.error}`);
      if (res.status === 'completed' && type === 'raw' && res.responseBody) {
        const md5 = JSON.parse(res.responseBody).md5;
        log(md5 === f.md5 ? 'MD5 MATCH' : `MD5 MISMATCH server=${md5}`);
      }
      setStatus(`simple ${res.status}`);
    } catch (e: any) {
      log(`simple failed: ${e.message}`);
      setStatus('error');
    }
  };

  const runMultipart = async (resumeFromSaved: boolean) => {
    const f = requireFile();
    if (!f) return;
    const count = Math.max(1, parseInt(parts, 10) || 1);
    try {
      let session = s3Ref.current;
      if (!resumeFromSaved || !session || session.urls.length !== count) {
        session = await createS3Upload(base, count, failure, parseInt(failPart, 10) || 1);
        s3Ref.current = session;
        etagsRef.current = [];
      }
      const uploadId = session.uploadId;
      log(`s3 uploadId ${uploadId}${resumeFromSaved ? ' (resuming)' : ''}`);
      setProgress(0);
      setStatus('multipart uploading');
      const upload = Upload.createMultipartS3({
        uploadId,
        path: f.path,
        parts: session.urls,
        maxParallel: parseInt(maxParallel, 10) || 3,
        existingEtags: resumeFromSaved && etagsRef.current.length === count ? etagsRef.current : undefined,
        notification: { enabled: true },
      });
      upload.onProgress(e => {
        if (e.progress != null) setProgress(e.progress);
        if (e.etags) etagsRef.current = e.etags;
        if (e.chunkIndex != null && e.etag) log(`part ${e.chunkIndex + 1} done`);
      });
      const result = await upload.start();
      log(`etags: ${result.etags.length}`);
      const done = await completeS3Upload(base, session, result.etags);
      log(`complete size=${done.size} md5=${done.md5}`);
      log(done.md5 === f.md5 ? 'MD5 MATCH' : `MD5 MISMATCH local=${f.md5}`);
      setStatus('multipart completed');
    } catch (e: any) {
      log(`multipart failed: ${e.code ?? ''} ${e.message}`);
      setStatus('multipart error');
    }
  };

  const runSuite = useCallback(async () => {
    setStatus('running all scenarios');
    const report = (line: string) => {
      log(line);
      fetch(`${base}/report`, { method: 'POST', body: line }).catch(() => {});
    };
    try {
      await runAll(base, report);
    } catch (e: any) {
      report(`suite crashed: ${e.message}`);
    }
    setStatus('suite finished');
  }, [base, log]);

  useEffect(() => {
    const report = (line: string) => {
      log(line);
      fetch(`${base}/report`, { method: 'POST', body: line }).catch(() => {});
    };
    const detach = attachBackgroundCompletion(report);
    fetch(`${base}/autorun`)
      .then(r => r.json())
      .then(r => {
        if (!r.run) return;
        if (r.mode === 'bg') startBackgroundUpload(base, report);
        else runSuite();
      })
      .catch(() => {});
    return detach;
  }, []);

  const withId = async (name: string, fn: (id: string) => Promise<boolean>) => {
    const id = s3Ref.current?.uploadId;
    if (!id) return log('no multipart upload');
    try {
      log(`${name}: ${await fn(id)}`);
    } catch (e: any) {
      log(`${name} failed: ${e.message}`);
    }
  };

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Upload Example</Text>

        <Section title="Server">
          <TextInput style={styles.input} value={base} onChangeText={setBase} autoCapitalize="none" autoCorrect={false} />
          <Text style={styles.hint}>Run `npm run server`. Use your LAN IP on a real device.</Text>
        </Section>

        <Section title="Test file">
          <View style={styles.row}>
            {SIZES.map(s => (
              <Button key={s} title={`${s} MB`} active={s === sizeMB} onPress={() => setSizeMB(s)} />
            ))}
          </View>
          <Button title="Generate file" onPress={generate} />
          <Text style={styles.hint}>{file ? `${file.size} bytes\nmd5 ${file.md5}` : 'No file'}</Text>
        </Section>

        <Section title="Failure injection">
          <View style={styles.row}>
            {FAILURES.map(f => (
              <Button key={f.label} title={f.label} active={f.value?.status === failure?.status && f.value?.times === failure?.times} onPress={() => setFailure(f.value)} />
            ))}
          </View>
          <Text style={styles.hint}>Applies to simple uploads and to the chosen part of the next multipart upload (new uploads only).</Text>
        </Section>

        <Section title="Automated">
          <Button title="Run all scenarios" onPress={runSuite} />
        </Section>

        <Section title="Background">
          <Button
            title="Start 50 MB background upload"
            onPress={() =>
              startBackgroundUpload(base, line => {
                log(line);
                fetch(`${base}/report`, { method: 'POST', body: line }).catch(() => {});
              })
            }
          />
          <Text style={styles.hint}>Slow parts (6s each). Send the app to the background; it finalizes itself.</Text>
        </Section>

        <Section title="Simple upload">
          <View style={styles.row}>
            <Button title="Raw PUT/POST" onPress={() => runSimple('raw')} />
            <Button title="Form multipart" onPress={() => runSimple('multipart')} />
            <Button title="Cancel" onPress={() => simpleRef.current?.cancel().catch(e => log(e.message))} />
          </View>
        </Section>

        <Section title="S3 multipart upload">
          <View style={styles.row}>
            <View style={styles.field}>
              <Text style={styles.hint}>Parts</Text>
              <TextInput style={styles.input} value={parts} onChangeText={setParts} keyboardType="number-pad" />
            </View>
            <View style={styles.field}>
              <Text style={styles.hint}>Parallel</Text>
              <TextInput style={styles.input} value={maxParallel} onChangeText={setMaxParallel} keyboardType="number-pad" />
            </View>
            <View style={styles.field}>
              <Text style={styles.hint}>Fail part</Text>
              <TextInput style={styles.input} value={failPart} onChangeText={setFailPart} keyboardType="number-pad" />
            </View>
          </View>
          <View style={styles.row}>
            <Button title="Start" onPress={() => runMultipart(false)} />
            <Button title="Resume saved ETags" onPress={() => runMultipart(true)} />
          </View>
          <View style={styles.row}>
            <Button title="Pause" onPress={() => withId('pause', Upload.pauseMultipartS3)} />
            <Button title="Resume" onPress={() => withId('resume', Upload.resumeMultipartS3)} />
            <Button title="Cancel" onPress={() => withId('cancel', Upload.cancelMultipartS3)} />
          </View>
        </Section>

        <Section title={`Status: ${status}`}>
          <View style={styles.bar}>
            <View style={[styles.barFill, { width: `${Math.round(progress * 100)}%` }]} />
          </View>
          <Text style={styles.hint}>{Math.round(progress * 100)}%</Text>
        </Section>

        <Section title="Log">
          {logs.map((l, i) => (
            <Text key={i} style={styles.log}>{l}</Text>
          ))}
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f4f4f6' },
  content: { padding: 16, gap: 12 },
  title: { fontSize: 24, fontWeight: '700' },
  section: { backgroundColor: '#fff', borderRadius: 10, padding: 12, gap: 8 },
  sectionTitle: { fontSize: 15, fontWeight: '600' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  field: { flex: 1, minWidth: 80 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 6, padding: 8, color: '#000' },
  hint: { fontSize: 12, color: '#666' },
  button: { borderWidth: 1, borderColor: '#2563eb', borderRadius: 6, paddingVertical: 8, paddingHorizontal: 12 },
  buttonActive: { backgroundColor: '#2563eb' },
  buttonText: { color: '#2563eb', fontWeight: '500' },
  buttonTextActive: { color: '#fff' },
  bar: { height: 8, backgroundColor: '#e5e7eb', borderRadius: 4, overflow: 'hidden' },
  barFill: { height: 8, backgroundColor: '#16a34a' },
  log: { fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
});
