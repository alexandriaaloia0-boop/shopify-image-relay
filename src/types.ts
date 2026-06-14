export interface ProcessedImage {
  buffer: Buffer;
  format: "jpeg";
  width: number;
  height: number;
  bytes: number;
  sha256: string;
}

export interface StoredImage {
  url: string;
  uploaded: boolean;
}

export interface ImageStorage {
  store(image: ProcessedImage): Promise<StoredImage>;
}
