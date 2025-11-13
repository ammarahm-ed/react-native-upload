/**
 * Handles HTTP background file uploads from an iOS or Android device.
 */
import { EmitterSubscription } from 'react-native';
export type UploadEvent = 'progress' | 'error' | 'completed' | 'cancelled';
export type NotificationOptions = {
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
export type UploadEventData = ProgressData | ErrorData | CancelledData | CompletedData;
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
    private changeCallback;
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
export declare const getFileInfo: (path: string) => Promise<FileInfo>;
export declare const startUpload: (options: UploadOptions) => Promise<string>;
export declare const cancelUpload: (cancelUploadId: string) => Promise<boolean>;
export declare const addListener: (eventType: UploadEvent, uploadId: string, listener: (data: UploadEventData) => void) => EmitterSubscription;
export declare const canSuspendIfBackground: () => void;
export declare const shouldLimitNetwork: (limit: boolean) => void;
export declare const getAllUploads: () => Promise<NativeUploadInfo[]>;
export { Upload };
export default Upload;
//# sourceMappingURL=index.d.ts.map