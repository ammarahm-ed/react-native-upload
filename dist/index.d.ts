/**
 * Handles HTTP background file uploads from an iOS or Android device.
 */
import { EmitterSubscription } from 'react-native';
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
export type UploadEventData = ProgressData | ErrorData | CancelledData | CompletedData;
export type MultipartEventType = "progress" | "error" | "completed" | "cancelled";
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
export declare const UploadState: {
    readonly Cancelled: "cancelled";
    readonly Completed: "completed";
    readonly Pending: "pending";
    readonly Running: "running";
    readonly Error: "error";
};
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
declare class Upload {
    private uploadId;
    private config;
    private subscriptions;
    private status;
    private startPromise;
    private resolveStart;
    private rejectStart;
    private changeCallbacks;
    constructor(config: UploadOptions);
    /**
     * Create a new upload instance or return existing one for the same path
     */
    static create(config: UploadOptions | MultipartUploadOptions): Upload;
    /**
     * Resume an existing upload by ID (useful after app restart)
     */
    static resume(uploadId: string): Promise<Upload | null>;
    /**
     * Get all currently tracked uploads
     */
    /**
     * Create an S3 / Cloud multipart chunked upload instance
     */
    static createMultipartS3(options: MultipartS3Options): MultipartS3Upload;
    /**
     * Start an S3 / Cloud multipart chunked upload directly
     */
    static startMultipartS3(options: MultipartS3Options): Promise<MultipartS3Result>;
    /**
     * Cancel an ongoing S3 multipart upload
     */
    static cancelMultipartS3(uploadId: string): Promise<boolean>;
    /**
     * Pause an ongoing S3 multipart upload
     */
    static pauseMultipartS3(uploadId: string): Promise<boolean>;
    /**
     * Resume a paused S3 multipart upload
     */
    static resumeMultipartS3(uploadId: string): Promise<boolean>;
    /**
     * Lists multipart uploads known to the native side, including ones that
     * finished while the app was suspended or relaunched in the background.
     */
    static getMultipartS3Uploads(): Promise<MultipartPendingUpload[]>;
    /**
     * Removes the stored state of a completed or failed multipart upload.
     */
    static acknowledgeMultipartS3(uploadId: string): Promise<boolean>;
    /**
     * Add listener for multipart events
     */
    static addMultipartListener(eventType: MultipartEventType, uploadId: string, listener: (data: any) => void): EmitterSubscription;
    static getAll(): Upload[];
    /**
     * Set a callback to be called whenever the upload state changes
     */
    onChange(callback: (event: UploadChangeEvent) => void): this;
    /**
     * Start the upload - resolves when upload completes, is cancelled, or errors
     */
    start(): Promise<UploadResult>;
    private setupEventListeners;
    private updateStatus;
    private notifyChange;
    private mapNativeStateToStatus;
    /**
     * Cancel the upload
     */
    cancel(): Promise<boolean>;
    /**
     * Get the current upload status
     */
    getStatus(): UploadStatus;
    /**
     * Get the upload ID
     */
    getId(): string | null;
    /**
     * Get the file path
     */
    getPath(): string;
    /**
     * Check if upload is in progress
     */
    isRunning(): boolean;
    /**
     * Clean up listeners
     */
    private cleanup;
}
declare class MultipartS3Upload {
    private options;
    private subscriptions;
    private startPromise;
    private progressCallbacks;
    private static activeUploads;
    constructor(options: MultipartS3Options);
    static create(options: MultipartS3Options): MultipartS3Upload;
    static getById(uploadId: string): MultipartS3Upload | undefined;
    static cancel(uploadId: string): Promise<boolean>;
    static pause(uploadId: string): Promise<boolean>;
    static resume(uploadId: string): Promise<boolean>;
    onProgress(callback: (event: MultipartProgressEvent) => void): this;
    getId(): string;
    getPath(): string;
    start(): Promise<MultipartS3Result>;
    private setupEventListeners;
    cancel(): Promise<boolean>;
    pause(): Promise<boolean>;
    resume(): Promise<boolean>;
    private cleanup;
}
export declare const startMultipartS3: (options: MultipartS3Options) => Promise<MultipartS3Result>;
export declare const cancelMultipartS3: (uploadId: string) => Promise<boolean>;
export declare const pauseMultipartS3: (uploadId: string) => Promise<boolean>;
export declare const resumeMultipartS3: (uploadId: string) => Promise<boolean>;
export declare const getMultipartS3Uploads: () => Promise<MultipartPendingUpload[]>;
export declare const acknowledgeMultipartS3: (uploadId: string) => Promise<boolean>;
export declare const addMultipartListener: (eventType: MultipartEventType, uploadId: string, listener: (data: any) => void) => EmitterSubscription;
export declare const getFileInfo: (path: string) => Promise<FileInfo>;
export declare const startUpload: (options: UploadOptions) => Promise<string>;
export declare const cancelUpload: (cancelUploadId: string) => Promise<boolean>;
export declare const addListener: (eventType: UploadEvent, uploadId: string, listener: (data: UploadEventData) => void) => EmitterSubscription;
export declare const canSuspendIfBackground: () => void;
export declare const shouldLimitNetwork: (limit: boolean) => void;
export declare const getAllUploads: () => Promise<NativeUploadInfo[]>;
export { Upload, MultipartS3Upload };
export default Upload;
//# sourceMappingURL=index.d.ts.map