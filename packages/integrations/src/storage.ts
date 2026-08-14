import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export type Storage = {
  put(
    key: string,
    body: Uint8Array | string,
    contentType?: string,
  ): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  presignGet(key: string, expiresInSeconds?: number): Promise<string>;
};

export type S3StorageConfig = {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region?: string;
};

export class NoopStorage implements Storage {
  readonly objects = new Map<string, Uint8Array>();
  async put(key: string, body: Uint8Array | string) {
    this.objects.set(
      key,
      typeof body === "string" ? new TextEncoder().encode(body) : body,
    );
  }
  async get(key: string) {
    return this.objects.get(key) ?? null;
  }
  async presignGet(key: string) {
    return `noop://storage/${encodeURIComponent(key)}`;
  }
}

export class S3Storage implements Storage {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}
  async put(key: string, body: Uint8Array | string, contentType?: string) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ...(contentType ? { ContentType: contentType } : {}),
      }),
    );
  }
  async get(key: string) {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!result.Body) return null;
    return new Uint8Array(await result.Body.transformToByteArray());
  }
  presignGet(key: string, expiresInSeconds = 900) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }
}

export function createConfiguredStorage(config?: S3StorageConfig): Storage {
  if (!config) return new NoopStorage();
  return new S3Storage(
    new S3Client({
      endpoint: config.endpoint,
      forcePathStyle: true,
      region: config.region ?? "us-east-1",
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
    }),
    config.bucket,
  );
}
