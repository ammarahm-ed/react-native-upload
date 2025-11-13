var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
/**
 * Handles HTTP background file uploads from an iOS or Android device.
 */
import { NativeModules, DeviceEventEmitter, Platform, } from 'react-native';
var NativeModule = NativeModules.VydiaRNFileUploader || NativeModules.RNFileUploader;
var eventPrefix = 'RNFileUploader-';
// for IOS, register event listeners or else they don't fire on DeviceEventEmitter
if (NativeModules.VydiaRNFileUploader) {
    NativeModule.addListener(eventPrefix + 'progress');
    NativeModule.addListener(eventPrefix + 'error');
    NativeModule.addListener(eventPrefix + 'cancelled');
    NativeModule.addListener(eventPrefix + 'completed');
}
export var UploadState = {
    Cancelled: 'cancelled',
    Completed: 'completed',
    Pending: 'pending',
    Running: 'running',
    Error: 'error',
};
// Global registry to track active uploads and prevent duplicates
var UploadRegistry = /** @class */ (function () {
    function UploadRegistry() {
    }
    UploadRegistry.register = function (upload) {
        var id = upload.getId();
        if (id) {
            this.uploads.set(id, upload);
        }
    };
    UploadRegistry.unregister = function (upload) {
        var id = upload.getId();
        if (id) {
            this.uploads.delete(id);
        }
    };
    UploadRegistry.getById = function (id) {
        return this.uploads.get(id);
    };
    UploadRegistry.has = function (id) {
        return this.uploads.has(id);
    };
    UploadRegistry.clear = function () {
        this.uploads.clear();
    };
    UploadRegistry.uploads = new Map();
    return UploadRegistry;
}());
var Upload = /** @class */ (function () {
    function Upload(config) {
        this.uploadId = null;
        this.subscriptions = [];
        this.status = UploadState.Pending;
        this.startPromise = null;
        this.resolveStart = null;
        this.rejectStart = null;
        this.changeCallback = null;
        this.config = config;
    }
    /**
     * Create a new upload instance or return existing one for the same path
     */
    Upload.create = function (config) {
        // Check if there's an existing upload for this upload id
        var existingUpload = config.customUploadId
            ? UploadRegistry.getById(config.customUploadId)
            : null;
        if (existingUpload && existingUpload.isRunning()) {
            console.warn("Upload already in progress for path: ".concat(config.path, ". Returning existing upload."));
            return existingUpload;
        }
        var upload = new Upload(config);
        return upload;
    };
    /**
     * Resume an existing upload by ID (useful after app restart)
     */
    Upload.resume = function (uploadId) {
        return __awaiter(this, void 0, void 0, function () {
            var existingUpload, nativeUploads, uploadInfo, upload;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        existingUpload = UploadRegistry.getById(uploadId);
                        if (existingUpload) {
                            return [2 /*return*/, existingUpload];
                        }
                        return [4 /*yield*/, getAllUploads()];
                    case 1:
                        nativeUploads = _a.sent();
                        uploadInfo = nativeUploads.find(function (u) { return u.id === uploadId; });
                        if (!uploadInfo) {
                            return [2 /*return*/, null];
                        }
                        upload = new Upload({ url: '', path: '' });
                        upload.uploadId = uploadId;
                        upload.status = upload.mapNativeStateToStatus(uploadInfo.state);
                        // Register and setup listeners
                        UploadRegistry.register(upload);
                        upload.setupEventListeners();
                        return [2 /*return*/, upload];
                }
            });
        });
    };
    /**
     * Get all currently tracked uploads
     */
    Upload.getAll = function () {
        var uploads = [];
        UploadRegistry.uploads.forEach(function (upload) { return uploads.push(upload); });
        return uploads;
    };
    /**
     * Set a callback to be called whenever the upload state changes
     */
    Upload.prototype.onChange = function (callback) {
        this.changeCallback = callback;
        return this;
    };
    /**
     * Start the upload - resolves when upload completes, is cancelled, or errors
     */
    Upload.prototype.start = function () {
        return __awaiter(this, void 0, void 0, function () {
            var nativeUploads, existingUpload, _a, error_1;
            var _this = this;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (this.uploadId) {
                            throw new Error('Upload already started');
                        }
                        if (this.startPromise) {
                            return [2 /*return*/, this.startPromise];
                        }
                        if (!this.config.path) return [3 /*break*/, 2];
                        return [4 /*yield*/, getAllUploads()];
                    case 1:
                        nativeUploads = _b.sent();
                        existingUpload = nativeUploads.find(function (u) { return u.state === 'running' || u.state === 'pending'; });
                        if (existingUpload && !this.config.customUploadId) {
                            console.warn("Found existing upload in native side. Resuming upload: ".concat(existingUpload.id));
                            this.uploadId = existingUpload.id;
                            this.status = this.mapNativeStateToStatus(existingUpload.state);
                            UploadRegistry.register(this);
                        }
                        _b.label = 2;
                    case 2:
                        this.startPromise = new Promise(function (resolve, reject) {
                            _this.resolveStart = resolve;
                            _this.rejectStart = reject;
                        });
                        // Register event listeners
                        this.setupEventListeners();
                        if (!!this.uploadId) return [3 /*break*/, 6];
                        _b.label = 3;
                    case 3:
                        _b.trys.push([3, 5, , 6]);
                        _a = this;
                        return [4 /*yield*/, NativeModule.startUpload(this.config)];
                    case 4:
                        _a.uploadId = _b.sent();
                        this.updateStatus(UploadState.Running);
                        UploadRegistry.register(this);
                        return [3 /*break*/, 6];
                    case 5:
                        error_1 = _b.sent();
                        this.cleanup();
                        if (this.rejectStart) {
                            this.rejectStart(error_1);
                        }
                        throw error_1;
                    case 6: return [2 /*return*/, this.startPromise];
                }
            });
        });
    };
    Upload.prototype.setupEventListeners = function () {
        var _this = this;
        // Progress listener
        var progressSubscription = DeviceEventEmitter.addListener(eventPrefix + 'progress', function (data) {
            if (_this.uploadId && data.id === _this.uploadId) {
                _this.notifyChange({
                    status: UploadState.Running,
                    progress: data.progress,
                });
            }
        });
        this.subscriptions.push(progressSubscription);
        // Completed listener
        var completedSubscription = DeviceEventEmitter.addListener(eventPrefix + 'completed', function (data) {
            if (_this.uploadId && data.id === _this.uploadId) {
                _this.updateStatus(UploadState.Completed, undefined, data.responseCode, data.responseBody);
                if (_this.resolveStart) {
                    _this.resolveStart({
                        status: 'completed',
                        responseCode: data.responseCode,
                        responseBody: data.responseBody,
                    });
                }
                _this.cleanup();
            }
        });
        this.subscriptions.push(completedSubscription);
        // Error listener
        var errorSubscription = DeviceEventEmitter.addListener(eventPrefix + 'error', function (data) {
            if (_this.uploadId && data.id === _this.uploadId) {
                _this.updateStatus(UploadState.Error, data.error);
                if (_this.resolveStart) {
                    _this.resolveStart({ status: 'error', error: data.error });
                }
                _this.cleanup();
            }
        });
        this.subscriptions.push(errorSubscription);
        // Cancelled listener
        var cancelledSubscription = DeviceEventEmitter.addListener(eventPrefix + 'cancelled', function (data) {
            if (_this.uploadId && data.id === _this.uploadId) {
                _this.updateStatus(UploadState.Cancelled, data.error);
                if (_this.resolveStart) {
                    _this.resolveStart({ status: 'cancelled', error: data.error });
                }
                _this.cleanup();
            }
        });
        this.subscriptions.push(cancelledSubscription);
    };
    Upload.prototype.updateStatus = function (status, error, responseCode, responseBody) {
        this.status = status;
        this.notifyChange({ status: status, error: error, responseCode: responseCode, responseBody: responseBody });
    };
    Upload.prototype.notifyChange = function (event) {
        if (this.changeCallback) {
            this.changeCallback(event);
        }
    };
    Upload.prototype.mapNativeStateToStatus = function (state) {
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
    };
    /**
     * Cancel the upload
     */
    Upload.prototype.cancel = function () {
        return __awaiter(this, void 0, void 0, function () {
            var result, error_2;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.uploadId) {
                            throw new Error('Upload not started');
                        }
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, NativeModule.cancelUpload(this.uploadId)];
                    case 2:
                        result = _a.sent();
                        // Don't cleanup here - let the cancelled event handle it
                        return [2 /*return*/, result];
                    case 3:
                        error_2 = _a.sent();
                        this.cleanup();
                        throw error_2;
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Get the current upload status
     */
    Upload.prototype.getStatus = function () {
        return this.status;
    };
    /**
     * Get the upload ID
     */
    Upload.prototype.getId = function () {
        return this.uploadId;
    };
    /**
     * Get the file path
     */
    Upload.prototype.getPath = function () {
        return this.config.path;
    };
    /**
     * Check if upload is in progress
     */
    Upload.prototype.isRunning = function () {
        return this.status === UploadState.Running;
    };
    /**
     * Clean up listeners
     */
    Upload.prototype.cleanup = function () {
        this.subscriptions.forEach(function (sub) { return sub.remove(); });
        this.subscriptions = [];
        this.resolveStart = null;
        this.rejectStart = null;
        UploadRegistry.unregister(this);
    };
    return Upload;
}());
// Legacy API exports for backward compatibility
export var getFileInfo = function (path) {
    return NativeModule.getFileInfo(path).then(function (data) {
        if (data.size) {
            data.size = +data.size;
        }
        return data;
    });
};
export var startUpload = function (options) {
    return NativeModule.startUpload(options);
};
export var cancelUpload = function (cancelUploadId) {
    if (typeof cancelUploadId !== 'string') {
        return Promise.reject(new Error('Upload ID must be a string'));
    }
    return NativeModule.cancelUpload(cancelUploadId);
};
export var addListener = function (eventType, uploadId, listener) {
    return DeviceEventEmitter.addListener(eventPrefix + eventType, function (data) {
        if (!uploadId || !data || !('id' in data) || data.id === uploadId) {
            listener(data);
        }
    });
};
export var canSuspendIfBackground = function () {
    if (Platform.OS === 'ios') {
        NativeModule.canSuspendIfBackground();
    }
};
export var shouldLimitNetwork = function (limit) {
    NativeModule.shouldLimitNetwork(limit);
};
export var getAllUploads = function () {
    return NativeModule.getAllUploads();
};
export { Upload };
export default Upload;
