/**
 * Handles HTTP background file uploads from an iOS or Android device.
 */
import {
  NativeModules,
  DeviceEventEmitter,
  Platform,
  EmitterSubscription,
} from 'react-native';

export type UploadEvent = 'progress' | 'error' | 'completed' | 'cancelled';

export type NotificationOptions = {
  filename: string;
  /**
   * Enable or diasable notifications. Works only on Android version < 8.0 Oreo. On Android versions >= 8.0 Oreo is required by Google's policy to display a notification when a background service run  { enabled: true }
   */
  enabled: boolean;
  /**
   * Autoclear notification on complete  { autoclear: true }
   */
  autoClear: boolean;
  /**
   * Sets android notificaion channel  { notificationChannel: "My-Upload-Service" }
   */
  notificationChannel: string;
  /**
   * Sets whether or not to enable the notification sound when the upload gets completed with success or error   { enableRingTone: true }
   */
  enableRingTone: boolean;
  /**
   * Sets notification progress title  { onProgressTitle: "Uploading" }
   */
  onProgressTitle: string;
  /**
   * Sets notification progress message  { onProgressMessage: "Uploading new video" }
   */
  onProgressMessage: string;
  /**
   * Sets notification complete title  { onCompleteTitle: "Upload finished" }
   */
  onCompleteTitle: string;
  /**
   * Sets notification complete message  { onCompleteMessage: "Your video has been uploaded" }
   */
  onCompleteMessage: string;
  /**
   * Sets notification error title   { onErrorTitle: "Upload error" }
   */
  onErrorTitle: string;
  /**
   * Sets notification error message   { onErrorMessage: "An error occured while uploading a video" }
   */
  onErrorMessage: string;
  /**
   * Sets notification cancelled title   { onCancelledTitle: "Upload cancelled" }
   */
  onCancelledTitle: string;
  /**
   * Sets notification cancelled message   { onCancelledMessage: "Video upload was cancelled" }
   */
  onCancelledMessage: string;
};

export type UploadOptions = {
  url: string;
  path: string;
  method?: 'PUT' | 'POST';
  type?: 'raw' | 'multipart';
  field?: string;
  /**
   * Provide this id to track uploads globally and avoid duplicate upload tasks
   */
  customUploadId?: string;
  parameters?: Record<string, string>;
  headers?: Record<string, string>;
  notification?: Partial<NotificationOptions>;
  /**
   * AppGroup defined in XCode for extensions. Necessary when trying to upload things via this library
   * in the context of ShareExtension.
   */
  appGroup?: string;
};

export interface MultipartUploadOptions extends UploadOptions {
  type: 'multipart';
  field: string;
  parameters?: {
    [index: string]: string;
  };
}

export interface FileInfo {
  exists: boolean;
  extension?: string;
  size?: number;
  mimeType?: string;
  name?: string;
}

export interface ProgressData {
  id: string;
  progress: number;
  totalBytes: number;
  uploadedBytes: number;
}

export interface ErrorData {
  id: string;
  error: string;
}

export interface CancelledData {
  id: string;
  error: string;
}

export interface CompletedData {
  id: string;
  responseCode?: number;
  responseBody?: string | null;
}

export type UploadEventData =
  | ProgressData
  | ErrorData
  | CancelledData
  | CompletedData;

const NativeModule = NativeModules.RNFileUploader;
const eventPrefix = 'RNFileUploader-';

// for IOS, register event listeners or else they don't fire on DeviceEventEmitter
if (NativeModules.RNFileUploader && NativeModule.addListener) {
  NativeModule.addListener(eventPrefix + 'progress');
  NativeModule.addListener(eventPrefix + 'error');
  NativeModule.addListener(eventPrefix + 'cancelled');
  NativeModule.addListener(eventPrefix + 'completed');
}

export const UploadState = {
  Cancelled: 'cancelled',
  Completed: 'completed',
  Pending: 'pending',
  Running: 'running',
  Error: 'error',
} as const;

export type UploadStatus = typeof UploadState[keyof typeof UploadState];

export interface UploadChangeEvent {
  status: UploadStatus;
  progress?: number;
  error?: string;
  totalBytes?: number;
  uploadedBytes?: number;
  responseCode?: number;
  responseBody?: string | null;
}

export interface UploadResult {
  status: UploadStatus;
  error?: string;
  responseCode?: number;
  responseBody?: string | null;
}

export interface NativeUploadInfo {
  id: string;
  state: UploadStatus;
}

// Global registry to track active uploads and prevent duplicates
class UploadRegistry {
  public static uploads: Map<string, Upload> = new Map();

  static register(upload: Upload): void {
    const id = upload.getId();
    if (id) {
      this.uploads.set(id, upload);
    }
  }

  static unregister(upload: Upload): void {
    const id = upload.getId();
    if (id) {
      this.uploads.delete(id);
    }
  }

  static getById(id: string): Upload | undefined {
    return this.uploads.get(id);
  }

  static has(id: string): boolean {
    return this.uploads.has(id);
  }

  static clear(): void {
    this.uploads.clear();
  }
}

class Upload {
  private uploadId: string | null = null;
  private config: UploadOptions;
  private subscriptions: EmitterSubscription[] = [];
  private status: UploadStatus = UploadState.Pending;
  private startPromise: Promise<UploadResult> | null = null;
  private resolveStart: ((result: UploadResult) => void) | null = null;
  private rejectStart: ((error: Error) => void) | null = null;
  private changeCallbacks: ((event: UploadChangeEvent) => void)[] = [];

  constructor(config: UploadOptions) {
    this.config = config;
  }

  /**
   * Create a new upload instance or return existing one for the same path
   */
  static create(config: UploadOptions | MultipartUploadOptions): Upload {
    // Check if there's an existing upload for this upload id
    const existingUpload = config.customUploadId
      ? UploadRegistry.getById(config.customUploadId)
      : null;

    if (existingUpload && existingUpload.isRunning()) {
      console.warn(
        `Upload already in progress for path: ${
          config.path
        }. Returning existing upload.`,
      );
      return existingUpload;
    }

    const upload = new Upload(config);
    return upload;
  }

  /**
   * Resume an existing upload by ID (useful after app restart)
   */
  static async resume(uploadId: string): Promise<Upload | null> {
    // Check if already tracked
    const existingUpload = UploadRegistry.getById(uploadId);
    if (existingUpload) {
      return existingUpload;
    }

    // Get all uploads from native side
    const nativeUploads = await getAllUploads();
    const uploadInfo = nativeUploads.find(u => u.id === uploadId);

    if (!uploadInfo) {
      return null;
    }

    // Create a minimal upload instance for resumed upload
    const upload = new Upload({ url: '', path: '' }); // We don't have the original config
    upload.uploadId = uploadId;
    upload.status = upload.mapNativeStateToStatus(uploadInfo.state);

    upload.startPromise = new Promise<UploadResult>((resolve, reject) => {
      upload.resolveStart = resolve;
      upload.rejectStart = reject;
    });

    // Register and setup listeners
    UploadRegistry.register(upload);

    upload.setupEventListeners();

    return upload;
  }

  /**
   * Get all currently tracked uploads
   */
  static getAll(): Upload[] {
    const uploads: Upload[] = [];
    UploadRegistry.uploads.forEach(upload => uploads.push(upload));
    return uploads;
  }

  /**
   * Set a callback to be called whenever the upload state changes
   */
  onChange(callback: (event: UploadChangeEvent) => void): this {
    if (!this.changeCallbacks.find(cb => cb === callback)) {
      this.changeCallbacks.push(callback);
    }
    return this;
  }

  /**
   * Start the upload - resolves when upload completes, is cancelled, or errors
   */
  async start(): Promise<UploadResult> {
    if (this.uploadId && this.startPromise) {
      return this.startPromise;
    }
    // Check if there's an existing upload for this path in native side
    if (this.config.customUploadId) {
      const nativeUploads = await getAllUploads();
      const existingUpload = nativeUploads.find(
        u =>
          u.id === this.config.customUploadId &&
          u.state !== 'error' &&
          u.state !== 'cancelled',
      );

      if (existingUpload) {
        console.warn(
          `Found existing upload in native side. Resuming upload: ${
            existingUpload.id
          }`,
        );
        this.uploadId = existingUpload.id;
        this.status = this.mapNativeStateToStatus(existingUpload.state);
        UploadRegistry.register(this);
      }
    }

    this.startPromise = new Promise<UploadResult>((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });

    // Register event listeners
    this.setupEventListeners();

    // If we resumed an existing upload, don't call native startUpload again
    if (!this.uploadId) {
      try {
        this.uploadId = await NativeModule.startUpload(this.config);
        this.updateStatus(UploadState.Running);
        UploadRegistry.register(this);
      } catch (error) {
        this.cleanup();
        if (this.rejectStart) {
          this.rejectStart(error as Error);
        }
        throw error;
      }
    }

    return this.startPromise;
  }

  private setupEventListeners(): void {
    // Progress listener
    const progressSubscription = DeviceEventEmitter.addListener(
      eventPrefix + 'progress',
      (data: ProgressData) => {
        if (this.uploadId && data.id === this.uploadId) {
          this.notifyChange({
            status: UploadState.Running,
            progress: data.progress,
            uploadedBytes: data.uploadedBytes,
            totalBytes: data.totalBytes,
          });
        }
      },
    );
    this.subscriptions.push(progressSubscription);

    // Completed listener
    const completedSubscription = DeviceEventEmitter.addListener(
      eventPrefix + 'completed',
      (data: CompletedData) => {
        if (this.uploadId && data.id === this.uploadId) {
          this.updateStatus(
            UploadState.Completed,
            undefined,
            data.responseCode,
            data.responseBody,
          );
          if (this.resolveStart) {
            this.resolveStart({
              status: 'completed',
              responseCode: data.responseCode,
              responseBody: data.responseBody,
            });
          }
          this.cleanup();
        }
      },
    );
    this.subscriptions.push(completedSubscription);

    // Error listener
    const errorSubscription = DeviceEventEmitter.addListener(
      eventPrefix + 'error',
      (data: ErrorData) => {
        if (this.uploadId && data.id === this.uploadId) {
          this.updateStatus(UploadState.Error, data.error);
          if (this.resolveStart) {
            this.resolveStart({ status: 'error', error: data.error });
          }
          this.cleanup();
        }
      },
    );
    this.subscriptions.push(errorSubscription);

    // Cancelled listener
    const cancelledSubscription = DeviceEventEmitter.addListener(
      eventPrefix + 'cancelled',
      (data: CancelledData) => {
        if (this.uploadId && data.id === this.uploadId) {
          this.updateStatus(UploadState.Cancelled, data.error);
          if (this.resolveStart) {
            this.resolveStart({ status: 'cancelled', error: data.error });
          }
          this.cleanup();
        }
      },
    );
    this.subscriptions.push(cancelledSubscription);
  }

  private updateStatus(
    status: UploadStatus,
    error?: string,
    responseCode?: number,
    responseBody?: string | null,
  ): void {
    this.status = status;
    this.notifyChange({ status, error, responseCode, responseBody });
  }

  private notifyChange(event: UploadChangeEvent): void {
    if (this.changeCallbacks.length) {
      this.changeCallbacks.forEach(cb => cb(event));
    }
  }

  private mapNativeStateToStatus(state: string): UploadStatus {
    switch (state) {
      case 'running':
        return UploadState.Running;
      case 'pending':
        return UploadState.Pending;
      case 'cancelled':
        return UploadState.Cancelled;
      case 'completed':
        return UploadState.Completed;
      default:
        return UploadState.Pending;
    }
  }

  /**
   * Cancel the upload
   */
  async cancel(): Promise<boolean> {
    if (!this.uploadId) {
      throw new Error('Upload not started');
    }

    try {
      const result = await NativeModule.cancelUpload(this.uploadId);
      // Don't cleanup here - let the cancelled event handle it
      return result;
    } catch (error) {
      this.cleanup();
      throw error;
    }
  }

  /**
   * Get the current upload status
   */
  getStatus(): UploadStatus {
    return this.status;
  }

  /**
   * Get the upload ID
   */
  getId(): string | null {
    return this.uploadId;
  }

  /**
   * Get the file path
   */
  getPath(): string {
    return this.config.path;
  }

  /**
   * Check if upload is in progress
   */
  isRunning(): boolean {
    return this.status === UploadState.Running;
  }

  /**
   * Clean up listeners
   */
  private cleanup(): void {
    this.subscriptions.forEach(sub => sub.remove());
    this.subscriptions = [];
    this.resolveStart = null;
    this.rejectStart = null;
    UploadRegistry.unregister(this);
  }
}

// Legacy API exports for backward compatibility
export const getFileInfo = (path: string): Promise<FileInfo> => {
  return NativeModule.getFileInfo(path).then((data: FileInfo) => {
    if (data.size) {
      data.size = +data.size;
    }
    return data;
  });
};

export const startUpload = (options: UploadOptions): Promise<string> =>
  NativeModule.startUpload(options);

export const cancelUpload = (cancelUploadId: string): Promise<boolean> => {
  if (typeof cancelUploadId !== 'string') {
    return Promise.reject(new Error('Upload ID must be a string'));
  }
  return NativeModule.cancelUpload(cancelUploadId);
};

export const addListener = (
  eventType: UploadEvent,
  uploadId: string,
  listener: (data: UploadEventData) => void,
): EmitterSubscription => {
  return DeviceEventEmitter.addListener(
    eventPrefix + eventType,
    (data: UploadEventData) => {
      if (!uploadId || !data || !('id' in data) || data.id === uploadId) {
        listener(data);
      }
    },
  );
};

export const canSuspendIfBackground = (): void => {
  if (Platform.OS === 'ios') {
    NativeModule.canSuspendIfBackground();
  }
};

export const shouldLimitNetwork = (limit: boolean): void => {
  NativeModule.shouldLimitNetwork(limit);
};

export const getAllUploads = async (): Promise<NativeUploadInfo[]> => {
  const allUploads = await NativeModule.getAllUploads();
  return allUploads;
};

export { Upload };

export default Upload;
