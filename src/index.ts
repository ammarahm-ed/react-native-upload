/**
 * Handles HTTP background file uploads from an iOS or Android device.
 */
import {
  AppRegistry,
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
   * Sets notification progress message. For multipart uploads {progress} is replaced with the percentage  { onProgressMessage: "Uploading new video" }
   */
  onProgressMessage: string;
  /**
   * Sets multipart upload notification start message  { onStartMessage: "Starting upload..." }
   */
  onStartMessage: string;
  /**
   * Sets multipart upload notification message when resuming  { onResumeMessage: "Resuming upload..." }
   */
  onResumeMessage: string;
  /**
   * Sets the Android notification channel name shown in system settings  { notificationChannelName: "Uploads" }
   */
  notificationChannelName: string;
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

export interface CancelledData {
  id: string;
  error: string;
}

export interface CompletedData {
  id: string;
  responseCode?: number;
  responseBody?: string | null;
}

export interface ErrorData extends CompletedData {
  error: string;
}

export type UploadEventData =
  | ProgressData
  | ErrorData
  | CancelledData
  | CompletedData;

export type MultipartEventType =
  | "progress"
  | "error"
  | "completed"
  | "cancelled";

export interface MultipartS3Options {
  /**
   * Unique upload ID to track the upload.
   */
  uploadId: string;
  /**
   * Path to the local file to upload (e.g. /path/to/file or file:///path/to/file).
   */
  path: string;
  /**
   * Array of presigned URLs for each chunk in sequence.
   */
  parts: string[];
  /**
   * Maximum parallel chunk uploads (default: 3).
   */
  maxParallel?: number;
  /**
   * Notification options for background service (Android).
   */
  notification?: Partial<NotificationOptions>;
  /**
   * AppGroup defined in Xcode for extensions (iOS).
   */
  appGroup?: string;
  /**
   * Fixed-length array of previously uploaded chunk ETags (matching parts array length)
   * for resuming an existing upload session. Completed parts carry their ETag string,
   * while uncompleted parts carry empty string "".
   * Already uploaded chunks will be skipped and pre-filled with these ETags.
   */
  existingEtags?: string[];
}

export interface MultipartProgressEvent {
  type: string;
  uploadId: string;
  progress?: number;
  bytesUploaded?: number;
  totalBytes?: number;
  chunkIndex?: number;
  etag?: string;
  etags?: string[];
  errorMessage?: string;
}

export type MultipartUploadStatus = "running" | "paused" | "completed" | "failed";

export interface MultipartPendingUpload {
  uploadId: string;
  status: MultipartUploadStatus;
  progress: number;
  bytesUploaded: number;
  totalBytes: number;
  etags: string[];
  error: string | null;
}

export interface MultipartS3Result {
  uploadId: string;
  success: boolean;
  etags: string[];
}

const NativeModule = NativeModules.RNFileUploader;
const eventPrefix = 'RNFileUploader-';

// for IOS, register event listeners or else they don't fire on DeviceEventEmitter
if (NativeModules.RNFileUploader && NativeModule.addListener) {
  NativeModule.addListener(eventPrefix + 'progress');
  NativeModule.addListener(eventPrefix + 'error');
  NativeModule.addListener(eventPrefix + 'cancelled');
  NativeModule.addListener(eventPrefix + 'completed');
  NativeModule.addListener(eventPrefix + 'multipart-progress');
  NativeModule.addListener(eventPrefix + 'multipart-error');
  NativeModule.addListener(eventPrefix + 'multipart-cancelled');
  NativeModule.addListener(eventPrefix + 'multipart-completed');
}

if (Platform.OS === 'android') {
  AppRegistry.registerHeadlessTask(
    'RNMultipartUploadKeepAlive',
    () => () => new Promise<void>(() => {}),
  );
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

  /**
   * Create an S3 / Cloud multipart chunked upload instance
   */
  static createMultipartS3(options: MultipartS3Options): MultipartS3Upload {
    return MultipartS3Upload.create(options);
  }

  /**
   * Start an S3 / Cloud multipart chunked upload directly
   */
  static startMultipartS3(options: MultipartS3Options): Promise<MultipartS3Result> {
    const upload = MultipartS3Upload.create(options);
    return upload.start();
  }

  /**
   * Cancel an ongoing S3 multipart upload
   */
  static cancelMultipartS3(uploadId: string): Promise<boolean> {
    return MultipartS3Upload.cancel(uploadId);
  }

  /**
   * Pause an ongoing S3 multipart upload
   */
  static pauseMultipartS3(uploadId: string): Promise<boolean> {
    return MultipartS3Upload.pause(uploadId);
  }

  /**
   * Resume a paused S3 multipart upload
   */
  static resumeMultipartS3(uploadId: string): Promise<boolean> {
    return MultipartS3Upload.resume(uploadId);
  }

  /**
   * Lists multipart uploads known to the native side, including ones that
   * finished while the app was suspended or relaunched in the background.
   */
  static getMultipartS3Uploads(): Promise<MultipartPendingUpload[]> {
    return NativeModule.getMultipartUploads();
  }

  /**
   * Removes the stored state of a completed or failed multipart upload.
   */
  static acknowledgeMultipartS3(uploadId: string): Promise<boolean> {
    return NativeModule.acknowledgeMultipartUpload(uploadId);
  }

  /**
   * Add listener for multipart events
   */
  static addMultipartListener(
    eventType: MultipartEventType,
    uploadId: string,
    listener: (data: any) => void,
  ): EmitterSubscription {
    return DeviceEventEmitter.addListener(
      eventPrefix + "multipart-" + eventType,
      (data: any) => {
        if (!uploadId || !data || data.uploadId === uploadId) {
          listener(data);
        }
      },
    );
  }

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
            this.resolveStart({
              status: 'error',
              error: data.error,
              responseBody: data.responseBody,
              responseCode: data.responseCode,
            });
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


class MultipartS3Upload {
  private options: MultipartS3Options;
  private subscriptions: EmitterSubscription[] = [];
  private startPromise: Promise<MultipartS3Result> | null = null;
  private progressCallbacks: ((event: MultipartProgressEvent) => void)[] = [];
  private static activeUploads: Map<string, MultipartS3Upload> = new Map();

  constructor(options: MultipartS3Options) {
    this.options = {
      ...options,
      maxParallel: options.maxParallel ?? 3,
    };
  }

  static create(options: MultipartS3Options): MultipartS3Upload {
    const existing = MultipartS3Upload.activeUploads.get(options.uploadId);
    if (existing) {
      return existing;
    }
    const upload = new MultipartS3Upload(options);
    MultipartS3Upload.activeUploads.set(options.uploadId, upload);
    return upload;
  }

  static getById(uploadId: string): MultipartS3Upload | undefined {
    return MultipartS3Upload.activeUploads.get(uploadId);
  }

  static async cancel(uploadId: string): Promise<boolean> {
    const instance = MultipartS3Upload.activeUploads.get(uploadId);
    if (instance) {
      return instance.cancel();
    }
    return NativeModule.cancelMultipartUpload(uploadId);
  }

  static async pause(uploadId: string): Promise<boolean> {
    const instance = MultipartS3Upload.activeUploads.get(uploadId);
    if (instance) {
      return instance.pause();
    }
    return NativeModule.pauseMultipartUpload(uploadId);
  }

  static async resume(uploadId: string): Promise<boolean> {
    const instance = MultipartS3Upload.activeUploads.get(uploadId);
    if (instance) {
      return instance.resume();
    }
    return NativeModule.resumeMultipartUpload(uploadId);
  }

  onProgress(callback: (event: MultipartProgressEvent) => void): this {
    if (!this.progressCallbacks.includes(callback)) {
      this.progressCallbacks.push(callback);
    }
    return this;
  }

  getId(): string {
    return this.options.uploadId;
  }

  getPath(): string {
    return this.options.path;
  }

  async start(): Promise<MultipartS3Result> {
    if (this.startPromise) {
      return this.startPromise;
    }

    this.setupEventListeners();

    this.startPromise = (async () => {
      try {
        const nativeResult = await NativeModule.startMultipartUpload(this.options);
        return nativeResult;
      } finally {
        this.cleanup();
      }
    })();

    return this.startPromise;
  }

  private setupEventListeners(): void {
    const progressSub = DeviceEventEmitter.addListener(
      eventPrefix + "multipart-progress",
      (data: MultipartProgressEvent) => {
        if (data.uploadId === this.options.uploadId) {
          this.progressCallbacks.forEach(cb => cb(data));
        }
      },
    );
    this.subscriptions.push(progressSub);
  }

  async cancel(): Promise<boolean> {
    try {
      const res = await NativeModule.cancelMultipartUpload(this.options.uploadId);
      this.cleanup();
      return res;
    } catch (err) {
      this.cleanup();
      throw err;
    }
  }

  async pause(): Promise<boolean> {
    return NativeModule.pauseMultipartUpload(this.options.uploadId);
  }

  async resume(): Promise<boolean> {
    return NativeModule.resumeMultipartUpload(this.options.uploadId);
  }

  private cleanup(): void {
    this.subscriptions.forEach(sub => sub.remove());
    this.subscriptions = [];
    MultipartS3Upload.activeUploads.delete(this.options.uploadId);
  }
}

export const startMultipartS3 = (options: MultipartS3Options): Promise<MultipartS3Result> =>
  Upload.startMultipartS3(options);

export const cancelMultipartS3 = (uploadId: string): Promise<boolean> =>
  Upload.cancelMultipartS3(uploadId);

export const pauseMultipartS3 = (uploadId: string): Promise<boolean> =>
  Upload.pauseMultipartS3(uploadId);

export const resumeMultipartS3 = (uploadId: string): Promise<boolean> =>
  Upload.resumeMultipartS3(uploadId);

export const getMultipartS3Uploads = (): Promise<MultipartPendingUpload[]> =>
  Upload.getMultipartS3Uploads();

export const acknowledgeMultipartS3 = (uploadId: string): Promise<boolean> =>
  Upload.acknowledgeMultipartS3(uploadId);

export const addMultipartListener = (
  eventType: MultipartEventType,
  uploadId: string,
  listener: (data: any) => void,
): EmitterSubscription =>
  Upload.addMultipartListener(eventType, uploadId, listener);

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

export { Upload, MultipartS3Upload };

export default Upload;
