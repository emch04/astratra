import { createS3Client, S3Error, signRequest, parseXml, type ObjectInfo, type ListObjectsResult } from './src/index';

async function exercise(): Promise<void> {
  const s3 = createS3Client({ endpoint: 'https://compte.r2.cloudflarestorage.com', accessKeyId: 'a', secretAccessKey: 'b', bucket: 'medias' });
  const put: { etag?: string } = await s3.putObject({ key: 'a.txt', body: 'x', contentType: 'text/plain', metadata: { auteur: 'x' }, ifNoneMatch: '*' });
  const got = await s3.getObject({ key: 'a.txt', range: 'bytes=0-9', maxBytes: 1024 });
  const body: Buffer = got.body;
  const info: ObjectInfo = await s3.headObject({ key: 'a.txt' });
  const list: ListObjectsResult = await s3.listObjects({ prefix: 'a/', maxKeys: 10 });
  for await (const object of s3.iterateObjects({ prefix: 'a/' })) void object.size;
  const url: string = s3.presignUrl({ key: 'a.txt', method: 'PUT', contentType: 'image/webp', expiresIn: 600 });
  const { stream } = await s3.getObjectStream({ key: 'a.txt' });
  stream.pipe(process.stdout);
  const removed = await s3.deleteObjects({ keys: ['a.txt'] });
  const request = s3.describeRequest('getObject', { key: 'a.txt' });
  const headers = signRequest({ method: 'GET', path: '/', headers: { host: 'x' }, region: 'auto', credentials: { accessKeyId: 'a', secretAccessKey: 'b' } });
  const root = parseXml('<a/>');
  try {
    await s3.deleteObject({ key: 'a.txt' });
  } catch (error) {
    if (error instanceof S3Error && error.$metadata.httpStatusCode === 404) void error.name;
  }
  void [put.etag, body.length, info.metadata, list.isTruncated, url, removed.deleted, request.path, headers.authorization, root.name];
}

void exercise;
