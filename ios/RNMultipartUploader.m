#import "RNMultipartUploader.h"

static int64_t const MIN_CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB for S3
static NSInteger const MAX_RETRIES = 3;

@interface RNMultipartSession : NSObject <NSURLSessionTaskDelegate, NSURLSessionDataDelegate>

@property (nonatomic, copy) NSString *uploadId;
@property (nonatomic, copy) NSString *filePath;
@property (nonatomic, copy) NSArray<NSString *> *uploadUrls;
@property (nonatomic, assign) NSInteger maxParallel;
@property (nonatomic, assign) int64_t totalBytes;
@property (nonatomic, assign) int64_t chunkSize;
@property (nonatomic, assign) int64_t bytesUploaded;
@property (nonatomic, strong) NSMutableDictionary<NSNumber *, NSURLSessionUploadTask *> *activeTasks;
@property (nonatomic, strong) NSMutableSet<NSNumber *> *completedChunks;
@property (nonatomic, strong) NSMutableDictionary<NSNumber *, NSNumber *> *retryCounts;
@property (nonatomic, strong) NSMutableArray<NSString *> *etags;
@property (nonatomic, strong) NSURLSession *session;
@property (nonatomic, copy) RCTPromiseResolveBlock resolve;
@property (nonatomic, copy) RCTPromiseRejectBlock reject;
@property (nonatomic, copy) void (^eventEmitter)(NSString *eventName, id body);
@property (nonatomic, strong) dispatch_queue_t queue;
@property (nonatomic, assign) BOOL isPaused;
@property (nonatomic, assign) BOOL hasEnded;

- (instancetype)initWithOptions:(NSDictionary *)options
                       resolver:(RCTPromiseResolveBlock)resolve
                       rejecter:(RCTPromiseRejectBlock)reject
                   eventEmitter:(void (^)(NSString *eventName, id body))eventEmitter;

- (void)start;
- (void)pause;
- (void)resume;
- (void)cancel;

@end

@implementation RNMultipartSession

- (instancetype)initWithOptions:(NSDictionary *)options
                       resolver:(RCTPromiseResolveBlock)resolve
                       rejecter:(RCTPromiseRejectBlock)reject
                   eventEmitter:(void (^)(NSString *eventName, id body))eventEmitter {
    self = [super init];
    if (self) {
        _uploadId = [options[@"uploadId"] copy];
        _resolve = [resolve copy];
        _reject = [reject copy];
        _eventEmitter = [eventEmitter copy];

        NSString *rawPath = options[@"path"];
        if ([rawPath hasPrefix:@"file://"]) {
            rawPath = [rawPath substringFromIndex:7];
        }
        _filePath = [rawPath stringByRemovingPercentEncoding] ?: rawPath;

        _uploadUrls = [options[@"parts"] copy];
        _maxParallel = [options[@"maxParallel"] integerValue] > 0 ? [options[@"maxParallel"] integerValue] : 3;

        _activeTasks = [NSMutableDictionary dictionary];
        _completedChunks = [NSMutableSet set];
        _retryCounts = [NSMutableDictionary dictionary];
        _etags = [NSMutableArray arrayWithCapacity:_uploadUrls.count];
        for (NSUInteger i = 0; i < _uploadUrls.count; i++) {
            [_etags addObject:@""];
        }

        NSString *queueLabel = [NSString stringWithFormat:@"com.reactnativeupload.multipart.%@", _uploadId];
        _queue = dispatch_queue_create([queueLabel UTF8String], DISPATCH_QUEUE_SERIAL);

        // Calculate file size
        NSDictionary *attrs = [[NSFileManager defaultManager] attributesOfItemAtPath:_filePath error:nil];
        _totalBytes = [attrs[NSFileSize] longLongValue];

        int64_t calculatedChunkSize = (int64_t)ceil((double)_totalBytes / (double)_uploadUrls.count);
        _chunkSize = MAX(calculatedChunkSize, MIN_CHUNK_SIZE);

        NSArray *existingEtags = options[@"existingEtags"];
        if (existingEtags && [existingEtags isKindOfClass:[NSArray class]]) {
            for (NSUInteger i = 0; i < existingEtags.count && i < _uploadUrls.count; i++) {
                NSString *etag = existingEtags[i];
                if ([etag isKindOfClass:[NSString class]] && etag.length > 0) {
                    _etags[i] = etag;
                    [_completedChunks addObject:@(i)];
                    int64_t offset = (int64_t)i * _chunkSize;
                    int64_t size = (i == _uploadUrls.count - 1) ? (_totalBytes - offset) : _chunkSize;
                    _bytesUploaded += size;
                }
            }
        }

        NSString *sessionId = [NSString stringWithFormat:@"com.reactnativeupload.multipart.%@", _uploadId];
        NSURLSessionConfiguration *config = [NSURLSessionConfiguration backgroundSessionConfigurationWithIdentifier:sessionId];
        config.isDiscretionary = NO;
        config.sessionSendsLaunchEvents = YES;

        NSString *appGroup = options[@"appGroup"];
        if (appGroup && appGroup.length > 0) {
            config.sharedContainerIdentifier = appGroup;
        }

        _session = [NSURLSession sessionWithConfiguration:config delegate:self delegateQueue:nil];
    }
    return self;
}

- (void)start {
    dispatch_async(self.queue, ^{
        if (self.hasEnded) return;

        if (self.bytesUploaded > 0 && self.eventEmitter) {
            double progress = self.totalBytes > 0 ? (double)self.bytesUploaded / (double)self.totalBytes : 1.0;
            self.eventEmitter(@"RNFileUploader-multipart-progress", @{
                @"uploadId": self.uploadId,
                @"progress": @(progress),
                @"bytesUploaded": @(self.bytesUploaded),
                @"totalBytes": @(self.totalBytes),
                @"chunkIndex": @(self.completedChunks.count - 1)
            });
        }

        if (self.completedChunks.count == self.uploadUrls.count) {
            [self finishSuccess];
            return;
        }

        [self uploadNextChunks];
    });
}

- (void)pause {
    dispatch_async(self.queue, ^{
        if (self.hasEnded || self.isPaused) return;
        self.isPaused = YES;
        for (NSURLSessionUploadTask *task in self.activeTasks.allValues) {
            [task suspend];
        }
    });
}

- (void)resume {
    dispatch_async(self.queue, ^{
        if (self.hasEnded || !self.isPaused) return;
        self.isPaused = NO;
        for (NSURLSessionUploadTask *task in self.activeTasks.allValues) {
            [task resume];
        }
        [self uploadNextChunks];
    });
}

- (void)cancel {
    dispatch_async(self.queue, ^{
        if (self.hasEnded) return;
        self.hasEnded = YES;

        for (NSURLSessionUploadTask *task in self.activeTasks.allValues) {
            [task cancel];
        }
        [self.activeTasks removeAllObjects];
        [self cleanupTempFiles];
        [self.session invalidateAndCancel];

        if (self.eventEmitter) {
            self.eventEmitter(@"RNFileUploader-multipart-cancelled", @{
                @"uploadId": self.uploadId,
                @"error": @"Upload cancelled"
            });
        }

        if (self.reject) {
            self.reject(@"CANCELLED", @"Upload cancelled", nil);
            self.resolve = nil;
            self.reject = nil;
        }
    });
}

- (void)uploadNextChunks {
    if (self.hasEnded || self.isPaused) return;

    while (self.activeTasks.count < (NSUInteger)self.maxParallel) {
        NSInteger nextIndex = -1;
        for (NSInteger i = 0; i < (NSInteger)self.uploadUrls.count; i++) {
            if (![self.completedChunks containsObject:@(i)] && !self.activeTasks[@(i)]) {
                nextIndex = i;
                break;
            }
        }

        if (nextIndex == -1) {
            if (self.activeTasks.count == 0 && self.completedChunks.count == self.uploadUrls.count) {
                [self finishSuccess];
            }
            return;
        }

        [self uploadChunkAtIndex:nextIndex];
    }
}

- (void)uploadChunkAtIndex:(NSInteger)index {
    int64_t offset = (int64_t)index * self.chunkSize;
    int64_t size = MIN(self.chunkSize, self.totalBytes - offset);

    NSString *tempPath = [NSTemporaryDirectory() stringByAppendingPathComponent:[NSString stringWithFormat:@"chunk_%@_%ld.tmp", self.uploadId, (long)index]];

    NSFileHandle *fileHandle = [NSFileHandle fileHandleForReadingAtPath:self.filePath];
    if (!fileHandle) {
        [self failWithError:[NSError errorWithDomain:@"RNMultipartUploader" code:-1 userInfo:@{NSLocalizedDescriptionKey: @"Cannot open file for reading"}]];
        return;
    }

    @try {
        [fileHandle seekToFileOffset:(unsigned long long)offset];
        NSData *chunkData = [fileHandle readDataOfLength:(NSUInteger)size];
        [fileHandle closeFile];

        [chunkData writeToFile:tempPath atomically:YES];

        NSURL *url = [NSURL URLWithString:self.uploadUrls[index]];
        NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
        [request setHTTPMethod:@"PUT"];
        [request setValue:@"application/octet-stream" forHTTPHeaderField:@"Content-Type"];
        [request setValue:[NSString stringWithFormat:@"%lld", (long long)size] forHTTPHeaderField:@"Content-Length"];

        NSURLSessionUploadTask *task = [self.session uploadTaskWithRequest:request fromFile:[NSURL fileURLWithPath:tempPath]];
        task.taskDescription = [NSString stringWithFormat:@"%ld", (long)index];
        self.activeTasks[@(index)] = task;
        [task resume];
    } @catch (NSException *exception) {
        [fileHandle closeFile];
        [self failWithError:[NSError errorWithDomain:@"RNMultipartUploader" code:-1 userInfo:@{NSLocalizedDescriptionKey: exception.reason ?: @"Exception while reading chunk"}]];
    }
}

- (void)cleanupTempFiles {
    NSFileManager *fm = [NSFileManager defaultManager];
    for (NSInteger i = 0; i < (NSInteger)self.uploadUrls.count; i++) {
        NSString *tempPath = [NSTemporaryDirectory() stringByAppendingPathComponent:[NSString stringWithFormat:@"chunk_%@_%ld.tmp", self.uploadId, (long)i]];
        [fm removeItemAtPath:tempPath error:nil];
    }
}

- (void)finishSuccess {
    if (self.hasEnded) return;
    self.hasEnded = YES;

    [self cleanupTempFiles];
    [self.session finishTasksAndInvalidate];

    NSDictionary *result = @{
        @"uploadId": self.uploadId,
        @"success": @YES,
        @"etags": [self.etags copy]
    };

    if (self.eventEmitter) {
        self.eventEmitter(@"RNFileUploader-multipart-completed", result);
    }

    if (self.resolve) {
        self.resolve(result);
        self.resolve = nil;
        self.reject = nil;
    }
}

- (void)failWithError:(NSError *)error {
    if (self.hasEnded) return;
    self.hasEnded = YES;

    for (NSURLSessionUploadTask *task in self.activeTasks.allValues) {
        [task cancel];
    }
    [self.activeTasks removeAllObjects];
    [self cleanupTempFiles];
    [self.session invalidateAndCancel];

    if (self.eventEmitter) {
        self.eventEmitter(@"RNFileUploader-multipart-error", @{
            @"uploadId": self.uploadId,
            @"error": error.localizedDescription ?: @"Upload failed"
        });
    }

    if (self.reject) {
        self.reject(@"MULTIPART_UPLOAD_ERROR", error.localizedDescription ?: @"Upload failed", error);
        self.resolve = nil;
        self.reject = nil;
    }
}

#pragma mark - NSURLSessionTaskDelegate

- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
    dispatch_async(self.queue, ^{
        if (self.hasEnded) return;

        NSInteger index = [task.taskDescription integerValue];
        [self.activeTasks removeObjectForKey:@(index)];

        NSString *tempPath = [NSTemporaryDirectory() stringByAppendingPathComponent:[NSString stringWithFormat:@"chunk_%@_%ld.tmp", self.uploadId, (long)index]];
        [[NSFileManager defaultManager] removeItemAtPath:tempPath error:nil];

        if (error) {
            NSInteger retries = [self.retryCounts[@(index)] integerValue];
            if (retries < MAX_RETRIES && !self.hasEnded && !self.isPaused) {
                self.retryCounts[@(index)] = @(retries + 1);
                [self uploadChunkAtIndex:index];
                return;
            } else {
                [self failWithError:error];
                return;
            }
        }

        NSHTTPURLResponse *httpResponse = (NSHTTPURLResponse *)task.response;
        if (httpResponse.statusCode < 200 || httpResponse.statusCode >= 300) {
            NSInteger retries = [self.retryCounts[@(index)] integerValue];
            if (retries < MAX_RETRIES && !self.hasEnded && !self.isPaused) {
                self.retryCounts[@(index)] = @(retries + 1);
                [self uploadChunkAtIndex:index];
                return;
            } else {
                NSString *msg = [NSString stringWithFormat:@"HTTP status %ld on chunk %ld", (long)httpResponse.statusCode, (long)index];
                [self failWithError:[NSError errorWithDomain:@"RNMultipartUploader" code:httpResponse.statusCode userInfo:@{NSLocalizedDescriptionKey: msg}]];
                return;
            }
        }

        NSString *etag = httpResponse.allHeaderFields[@"ETag"] ?: httpResponse.allHeaderFields[@"Etag"] ?: httpResponse.allHeaderFields[@"etag"] ?: @"";
        etag = [etag stringByTrimmingCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@"\""]];

        if (etag.length == 0) {
            [self failWithError:[NSError errorWithDomain:@"RNMultipartUploader" code:-1 userInfo:@{NSLocalizedDescriptionKey: [NSString stringWithFormat:@"Missing ETag on chunk %ld", (long)index]}]];
            return;
        }

        self.etags[index] = etag;
        [self.completedChunks addObject:@(index)];

        int64_t offset = (int64_t)index * self.chunkSize;
        int64_t size = MIN(self.chunkSize, self.totalBytes - offset);
        self.bytesUploaded += size;

        double progress = self.totalBytes > 0 ? (double)self.bytesUploaded / (double)self.totalBytes : 1.0;

        if (self.eventEmitter) {
            self.eventEmitter(@"RNFileUploader-multipart-progress", @{
                @"uploadId": self.uploadId,
                @"progress": @(progress),
                @"bytesUploaded": @(self.bytesUploaded),
                @"totalBytes": @(self.totalBytes),
                @"chunkIndex": @(index),
                @"etag": etag ?: @"",
                @"etags": [self.etags copy]
            });
        }

        if (self.completedChunks.count == self.uploadUrls.count) {
            [self finishSuccess];
        } else {
            [self uploadNextChunks];
        }
    });
}

@end

@interface RNMultipartUploader ()
@property (nonatomic, strong) NSMutableDictionary<NSString *, RNMultipartSession *> *sessions;
@property (nonatomic, strong) dispatch_queue_t lockQueue;
@end

@implementation RNMultipartUploader

+ (instancetype)sharedInstance {
    static RNMultipartUploader *instance = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        instance = [[RNMultipartUploader alloc] init];
    });
    return instance;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        _sessions = [NSMutableDictionary dictionary];
        _lockQueue = dispatch_queue_create("com.reactnativeupload.multipart.manager", DISPATCH_QUEUE_SERIAL);
    }
    return self;
}

- (void)startUploadWithOptions:(NSDictionary *)options
                      resolver:(RCTPromiseResolveBlock)resolve
                      rejecter:(RCTPromiseRejectBlock)reject
                  eventEmitter:(void (^)(NSString *eventName, id body))eventEmitter {
    NSString *uploadId = options[@"uploadId"];
    if (!uploadId || uploadId.length == 0) {
        reject(@"INVALID_ARGUMENT", @"uploadId is required", nil);
        return;
    }

    NSString *filePath = options[@"path"];
    if (!filePath || filePath.length == 0) {
        reject(@"INVALID_ARGUMENT", @"path is required", nil);
        return;
    }

    NSArray *parts = options[@"parts"];
    if (!parts || parts.count == 0) {
        reject(@"INVALID_ARGUMENT", @"parts array cannot be empty", nil);
        return;
    }

    NSString *localPath = filePath;
    if ([localPath hasPrefix:@"file://"]) {
        localPath = [localPath substringFromIndex:7];
    }
    localPath = [localPath stringByRemovingPercentEncoding] ?: localPath;

    BOOL isDirectory = NO;
    if (![[NSFileManager defaultManager] fileExistsAtPath:localPath isDirectory:&isDirectory] || isDirectory) {
        reject(@"INVALID_ARGUMENT", [NSString stringWithFormat:@"File does not exist: %@", localPath], nil);
        return;
    }

    NSDictionary *attrs = [[NSFileManager defaultManager] attributesOfItemAtPath:localPath error:nil];
    int64_t fileSize = [attrs[NSFileSize] longLongValue];
    if (fileSize <= 0) {
        reject(@"INVALID_ARGUMENT", @"File is empty", nil);
        return;
    }

    int64_t partsCount = (int64_t)parts.count;
    int64_t chunkSize = MAX((int64_t)ceil((double)fileSize / (double)partsCount), MIN_CHUNK_SIZE);
    if ((partsCount - 1) * chunkSize >= fileSize) {
        reject(@"INVALID_ARGUMENT", [NSString stringWithFormat:@"File size (%lld bytes) is too small for %lld parts. Each part except the last must be at least %lld bytes.", fileSize, partsCount, (long long)MIN_CHUNK_SIZE], nil);
        return;
    }

    dispatch_async(self.lockQueue, ^{
        if (self.sessions[uploadId]) {
            reject(@"ALREADY_EXISTS", [NSString stringWithFormat:@"Upload already in progress for %@", uploadId], nil);
            return;
        }

        NSString *filename = [filePath lastPathComponent];
        RNMultipartSession *session = [[RNMultipartSession alloc] initWithOptions:options
                                                                         resolver:^(id result) {
            dispatch_async(self.lockQueue, ^{
                [self.sessions removeObjectForKey:uploadId];
                if (filename.length > 0) [self.sessions removeObjectForKey:filename];
            });
            resolve(result);
        } rejecter:^(NSString *code, NSString *message, NSError *error) {
            dispatch_async(self.lockQueue, ^{
                [self.sessions removeObjectForKey:uploadId];
                if (filename.length > 0) [self.sessions removeObjectForKey:filename];
            });
            reject(code, message, error);
        } eventEmitter:eventEmitter];

        self.sessions[uploadId] = session;
        if (filename.length > 0) {
            self.sessions[filename] = session;
        }
        [session start];
    });
}

- (BOOL)cancelUpload:(NSString *)uploadIdOrKey {
    __block BOOL found = NO;
    dispatch_sync(self.lockQueue, ^{
        RNMultipartSession *session = self.sessions[uploadIdOrKey];
        if (session) {
            found = YES;
            [session cancel];
            [self.sessions removeObjectForKey:session.uploadId];
            NSString *filename = [session.filePath lastPathComponent];
            if (filename.length > 0) {
                [self.sessions removeObjectForKey:filename];
            }
        }
    });
    return found;
}

- (BOOL)pauseUpload:(NSString *)uploadId {
    __block BOOL found = NO;
    dispatch_sync(self.lockQueue, ^{
        RNMultipartSession *session = self.sessions[uploadId];
        if (session) {
            found = YES;
            [session pause];
        }
    });
    return found;
}

- (BOOL)resumeUpload:(NSString *)uploadId {
    __block BOOL found = NO;
    dispatch_sync(self.lockQueue, ^{
        RNMultipartSession *session = self.sessions[uploadId];
        if (session) {
            found = YES;
            [session resume];
        }
    });
    return found;
}

@end
