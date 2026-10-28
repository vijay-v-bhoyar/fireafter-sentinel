import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, writeFile, mkdir, stat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdDecompress } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function verifyArtifact(file, bytes, expectedHash) {
  if ((await stat(file)).size !== bytes) throw Error('Artifact size mismatch.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest('hex') !== expectedHash) throw Error('Artifact hash mismatch.');
}
async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== '--out' || !args[1] || args.length > 3 || (args[2] && args[2] !== '--check')) throw Error('Use --out DIRECTORY [--check].');
  const out = path.resolve(args[1]);
  const outputRoot = await realpath(path.join(root, 'output'));
  const relative = path.relative(outputRoot, out);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Use an output subdirectory.');
  if (args[2] !== '--check') {
    if (await realpath(path.dirname(out)) !== path.dirname(out)) throw Error('Redirected output parent.');
    await mkdir(out); // Existing/partial downloads are preserved, never overwritten.
  }
  const { artifacts } = JSON.parse(await readFile(new URL('./sentinel-native-artifacts.json', import.meta.url), 'utf8'));
  for (const artifact of artifacts) {
    const archive = path.join(out, artifact.service + '-runtime.tar.zst');
    const tar = path.join(out, artifact.service + '-runtime.tar');
    if (args[2] !== '--check') {
      const url = new URL(artifact.source);
      if (url.origin !== 'https://supabase-cli-artifacts.s3.us-east-1.amazonaws.com') throw Error('Unexpected runtime host.');
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120000) });
      if (response.status !== 200 || !response.body) throw Error('Runtime download failed.');
      await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, { flags: 'wx' }));
      await verifyArtifact(archive, artifact.archiveBytes, artifact.archiveSha256);
      await pipeline(createReadStream(archive), createZstdDecompress(), createWriteStream(tar, { flags: 'wx' }));
    }
    await verifyArtifact(archive, artifact.archiveBytes, artifact.archiveSha256);
    await verifyArtifact(tar, artifact.tarBytes, artifact.tarSha256);
  }
  const receipt = { status: 'PINNED_ARTIFACTS_VERIFIED', artifacts: artifacts.length, downloadRequests: args[2] === '--check' ? 0 : artifacts.length, providerCalls: 0 };
  if (args[2] !== '--check') await writeFile(path.join(out, 'download-receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('Runtime artifact preparation failed; partial files retained.'); process.exitCode = 1; });
