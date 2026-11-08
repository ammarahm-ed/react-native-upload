import type { TurboModule, CodegenTypes } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  shouldLimitNetwork(limit: boolean): void;
  canSuspendIfBackground(): void;
  getFileInfo(path: string): Promise<CodegenTypes.UnsafeObject>;
  startUpload(options: CodegenTypes.UnsafeObject): Promise<string>;
  cancelUpload(uploadId: string): Promise<boolean>;
  stopAllUploads(): Promise<boolean>;
  getAllUploads(): Promise<Array<CodegenTypes.UnsafeObject>>;
  startMultipartUpload(
    options: CodegenTypes.UnsafeObject,
  ): Promise<CodegenTypes.UnsafeObject>;
  cancelMultipartUpload(uploadId: string): Promise<boolean>;
  pauseMultipartUpload(uploadId: string): Promise<boolean>;
  resumeMultipartUpload(uploadId: string): Promise<boolean>;
  getMultipartUploads(): Promise<Array<CodegenTypes.UnsafeObject>>;
  acknowledgeMultipartUpload(uploadId: string): Promise<boolean>;
  addListener(eventName: string): void;
  removeListeners(count: CodegenTypes.Int32): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('RNFileUploader');
