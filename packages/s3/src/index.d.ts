import type { Readable } from 'node:stream';
import type { Agent as HttpAgent } from 'node:http';

export interface S3ClientOptions {
  /** "https://<account>.r2.cloudflarestorage.com", "http://127.0.0.1:9000"…; without it, the S3 address of `region`. */
  endpoint?: string;
  /** "auto" for R2 (default); the AWS region otherwise. */
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** The default bucket. */
  bucket?: string;
  /** "https://host/bucket/key" instead of "https://bucket.host/key" (always for an IP, localhost, or a dotted bucket over https). */
  forcePathStyle?: boolean;
  /** Default 30 000. */
  timeoutMs?: number;
  agent?: HttpAgent;
  now?: () => number;
}

export interface ObjectInfo {
  contentType?: string;
  contentLength?: number;
  contentRange?: string;
  /** Without quotes. */
  etag?: string;
  lastModified?: Date;
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  versionId?: string;
  /** x-amz-meta-* headers, names in lowercase without the prefix. */
  metadata: Record<string, string>;
}

export interface PutObjectInput {
  bucket?: string;
  key: string;
  body: Uint8Array | string;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  /** Letters, digits and hyphens; printable ASCII values; 2 KB in all. */
  metadata?: Record<string, string | number>;
  /** "*": only if the object does not exist yet (412 otherwise). */
  ifNoneMatch?: '*';
  ifMatch?: string;
}

export interface ListedObject {
  key: string;
  size: number;
  etag?: string;
  lastModified?: Date;
  storageClass?: string;
}

export interface ListObjectsResult {
  objects: ListedObject[];
  prefixes: string[];
  isTruncated: boolean;
  nextContinuationToken?: string;
  keyCount?: number;
}

export interface DescribedRequest {
  method: string;
  protocol: string;
  hostname: string;
  port: number | null;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  bodyLength: number;
}

export interface S3Client {
  putObject(input: PutObjectInput): Promise<{ etag?: string; versionId?: string }>;
  /** In memory, up to `maxBytes` (100 MiB by default). */
  getObject(input: { bucket?: string; key: string; range?: string; maxBytes?: number }): Promise<ObjectInfo & { body: Buffer }>;
  getObjectStream(input: { bucket?: string; key: string; range?: string }): Promise<ObjectInfo & { stream: Readable }>;
  /** A missing object throws an S3Error named "NotFound" (404). */
  headObject(input: { bucket?: string; key: string }): Promise<ObjectInfo>;
  deleteObject(input: { bucket?: string; key: string }): Promise<{ versionId?: string }>;
  deleteObjects(input: { bucket?: string; keys: string[] }): Promise<{ deleted: string[]; errors: { key?: string; code?: string; message?: string }[] }>;
  listObjects(input?: { bucket?: string; prefix?: string; delimiter?: string; continuationToken?: string; startAfter?: string; maxKeys?: number }): Promise<ListObjectsResult>;
  iterateObjects(input?: { bucket?: string; prefix?: string; limit?: number }): AsyncGenerator<ListedObject>;
  /** A presigned URL; `expiresIn` seconds (900 by default, 7 days at most). A PUT signs `contentType` and `contentLength`. */
  presignUrl(input: {
    bucket?: string;
    key: string;
    method?: 'GET' | 'PUT' | 'HEAD' | 'DELETE';
    expiresIn?: number;
    contentType?: string;
    contentLength?: number;
    responseContentType?: string;
    responseContentDisposition?: string;
    responseCacheControl?: string;
  }): string;
  /** The signed request an operation would send, without sending it. */
  describeRequest(operation: 'putObject' | 'getObject' | 'getObjectStream' | 'headObject' | 'deleteObject' | 'deleteObjects' | 'listObjects', input: object): DescribedRequest;
}

export function createS3Client(options: S3ClientOptions): S3Client;

/** Shaped like the AWS SDK's errors: `name` is the S3 code (NoSuchKey, AccessDenied, NotFound…). */
export class S3Error extends Error {
  Code: string;
  $fault: 'client' | 'server';
  $metadata: { httpStatusCode?: number; requestId?: string };
  Resource?: string;
  Key?: string;
}

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}
export function signRequest(options: { method: string; path: string; query?: Record<string, string | number | undefined>; headers: Record<string, string>; payloadHash?: string; region: string; service?: string; credentials: Credentials; date?: Date }): Record<string, string>;
export function presignQuery(options: { method: string; path: string; query?: Record<string, string | number | undefined>; headers: Record<string, string>; region: string; service?: string; credentials: Credentials; date?: Date; expiresIn: number; contentSha256Param?: boolean }): string;
export function encodeRfc3986(value: string): string;
export function encodePath(path: string): string;
export function canonicalQuery(query: Record<string, string | number | undefined | null>): string;
export function sha256Hex(data: string | Uint8Array): string;
export function amzDate(date: Date): { stamp: string; day: string };
export const UNSIGNED_PAYLOAD: 'UNSIGNED-PAYLOAD';
export const EMPTY_SHA256: string;

export interface XmlNode {
  name: string;
  children: XmlNode[];
  text: string;
}
export function parseXml(input: string | Buffer, options?: { maxBytes?: number; maxDepth?: number; maxNodes?: number }): XmlNode;
export function child(node: XmlNode, name: string): XmlNode | undefined;
export function childrenOf(node: XmlNode, name: string): XmlNode[];
export function textOf(node: XmlNode, name: string): string | undefined;
export function escapeXml(value: unknown): string;
export class XmlError extends Error {}
