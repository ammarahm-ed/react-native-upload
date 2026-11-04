#import "RNMultipartUploader.h"

static NSString *const SESSION_IDENTIFIER = @"com.reactnativeupload.multipart";
static int64_t const MIN_CHUNK_SIZE = 5 * 1024 * 1024;
static NSInteger const MAX_RETRIES = 3;
static NSUInteger const COPY_BLOCK_SIZE = 1024 * 1024;

static NSString *const STATUS_RUNNING = @"running";
static NSString *const STATUS_PAUSED = @"paused";
static NSString *const STATUS_COMPLETED = @"completed";
static NSString *const STATUS_FAILED = @"failed";

@interface RNMultipartSession : NSObject

@property (nonatomic, copy) NSString *uploadId;
@property (nonatomic, copy) NSString *filePath;
@property (nonatomic, copy) NSString *tempDirectory;
@property (nonatomic, copy) NSString *appGroup;
@property (nonatomic, copy) NSString *status;
@property (nonatomic, copy) NSString *errorMessage;
@property (nonatomic, assign) BOOL resumable;
@property (nonatomic, copy) NSArray<NSString *> *urls;
@property (nonatomic, assign) NSInteger maxParallel;
@property (nonatomic, assign) int64_t totalBytes;
@property (nonatomic, assign) int64_t chunkSize;
@property (nonatomic, strong) NSMutableArray<NSString *> *etags;
@property (nonatomic, strong) NSMutableDictionary<NSNumber *, NSURLSessionUploadTask *> *activeTasks;
@property (nonatomic, strong) NSMutableDictionary<NSNumber *, NSNumber *> *retryCounts;
@property (nonatomic, strong) NSMutableSet<NSNumber *> *pendingRetries;
@property (nonatomic, copy) RCTPromiseResolveBlock resolve;
@property (nonatomic, copy) RCTPromiseRejectBlock reject;

@end

@implementation RNMultipartSession

- (instancetype)init {
    self = [super init];
    if (self) {
        _activeTasks = [NSMutableDictionary dictionary];
        _retryCounts = [NSMutableDictionary dictionary];
        _pendingRetries = [NSMutableSet set];
    }
    return self;
}

- (BOOL)isActive {
    return [self.status isEqualToString:STATUS_RUNNING] || [self.status isEqualToString:STATUS_PAUSED];
}

- (int64_t)sizeOfChunk:(NSInteger)index {
    int64_t offset = (int64_t)index * self.chunkSize;
    return MAX(0, MIN(self.chunkSize, self.totalBytes - offset));
}

- (NSInteger)completedCount {
    NSInteger count = 0;
    for (NSString *etag in self.etags) {
        if (etag.length > 0) count++;
    }
    return count;
}

- (int64_t)bytesUploaded {
    int64_t bytes = 0;
    for (NSInteger i = 0; i < (NSInteger)self.etags.count; i++) {
        if (self.etags[i].length > 0) bytes += [self sizeOfChunk:i];
    }
    return bytes;
}

- (double)progress {
    return self.totalBytes > 0 ? (double)[self bytesUploaded] / (double)self.totalBytes : 1.0;
}

- (NSString *)chunkPath:(NSInteger)index {
    return [self.tempDirectory stringByAppendingPathComponent:[NSString stringWithFormat:@"chunk_%@_%ld.tmp", self.uploadId, (long)index]];
}

- (void)cleanupTempFiles {
    NSFileManager *fm = [NSFileManager defaultManager];
    NSString *prefix = [NSString stringWithFormat:@"chunk_%@_", self.uploadId];
    for (NSString *name in [fm contentsOfDirectoryAtPath:self.tempDirectory error:nil]) {
        if ([name hasPrefix:prefix]) {
            [fm removeItemAtPath:[self.tempDirectory stringByAppendingPathComponent:name] error:nil];
        }
    }
}

@end

@interface RNMultipartUploader () <NSURLSessionTaskDelegate>

@property (nonatomic, strong) NSMutableDictionary<NSString *, RNMultipartSession *> *sessions;
@property (nonatomic, strong) dispatch_queue_t queue;
@property (nonatomic, strong) NSURLSession *urlSession;
@property (nonatomic, copy) void (^eventEmitter)(NSString *eventName, id body);
@property (nonatomic, strong) NSMutableArray<NSDictionary *> *bufferedEvents;
@property (nonatomic, copy) void (^pendingBackgroundHandler)(void);
@property (nonatomic, assign) BOOL restored;
@property (nonatomic, assign) BOOL tasksLoaded;
@property (nonatomic, assign) BOOL finishEventsPending;

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

+ (NSString *)sessionIdentifier {
    return SESSION_IDENTIFIER;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        _sessions = [NSMutableDictionary dictionary];
        _bufferedEvents = [NSMutableArray array];
        _queue = dispatch_queue_create("com.reactnativeupload.multipart.manager", DISPATCH_QUEUE_SERIAL);
    }
    return self;
}

#pragma mark - Events

- (void)setEventEmitter:(void (^)(NSString *, id))eventEmitter {
    dispatch_async(self.queue, ^{
        self->_eventEmitter = [eventEmitter copy];
        if (self->_eventEmitter) {
            NSArray *buffered = [self.bufferedEvents copy];
            [self.bufferedEvents removeAllObjects];
            for (NSDictionary *event in buffered) {
                self->_eventEmitter(event[@"name"], event[@"body"]);
            }
        }
    });
}

- (void)emit:(NSString *)name body:(NSDictionary *)body buffered:(BOOL)buffered {
    if (self.eventEmitter) {
        self.eventEmitter(name, body);
    } else if (buffered) {
        [self.bufferedEvents addObject:@{@"name": name, @"body": body}];
    }
}

- (void)emitProgress:(RNMultipartSession *)session chunkIndex:(NSInteger)index etag:(NSString *)etag {
    NSMutableDictionary *body = [@{
        @"uploadId": session.uploadId,
        @"progress": @([session progress]),
        @"bytesUploaded": @([session bytesUploaded]),
        @"totalBytes": @(session.totalBytes),
        @"chunkIndex": @(index),
        @"etags": [session.etags copy]
    } mutableCopy];
    if (etag) body[@"etag"] = etag;
    [self emit:@"RNFileUploader-multipart-progress" body:body buffered:NO];
}

#pragma mark - Persistence

- (NSString *)supportDirectory {
    NSString *base = NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES).firstObject;
    NSString *dir = [base stringByAppendingPathComponent:@"RNMultipartUploader"];
    [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
    return dir;
}

- (NSString *)stateFilePath {
    return [[self supportDirectory] stringByAppendingPathComponent:@"state.json"];
}

- (NSString *)chunkDirectoryForAppGroup:(NSString *)appGroup {
    NSString *dir = nil;
    if (appGroup.length > 0) {
        NSURL *container = [[NSFileManager defaultManager] containerURLForSecurityApplicationGroupIdentifier:appGroup];
        if (container) dir = [[container path] stringByAppendingPathComponent:@"RNMultipartChunks"];
    }
    if (!dir) dir = [[self supportDirectory] stringByAppendingPathComponent:@"chunks"];
    [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
    [[NSURL fileURLWithPath:dir] setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
    return dir;
}

- (void)persist {
    NSMutableArray *entries = [NSMutableArray array];
    for (RNMultipartSession *s in self.sessions.allValues) {
        if (!s.resumable) continue;
        [entries addObject:@{
            @"uploadId": s.uploadId,
            @"path": s.filePath,
            @"parts": s.urls,
            @"maxParallel": @(s.maxParallel),
            @"totalBytes": @(s.totalBytes),
            @"chunkSize": @(s.chunkSize),
            @"etags": s.etags,
            @"status": s.status,
            @"error": s.errorMessage ?: @"",
            @"tempDirectory": s.tempDirectory,
            @"appGroup": s.appGroup ?: @""
        }];
    }
    NSData *data = [NSJSONSerialization dataWithJSONObject:entries options:0 error:nil];
    [data writeToFile:[self stateFilePath] atomically:YES];
}

- (void)restoreLocked {
    if (self.restored) return;
    self.restored = YES;

    NSData *data = [NSData dataWithContentsOfFile:[self stateFilePath]];
    NSArray *entries = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    if (![entries isKindOfClass:[NSArray class]]) {
        entries = @[];
    }

    for (NSDictionary *e in entries) {
        RNMultipartSession *s = [[RNMultipartSession alloc] init];
        s.uploadId = e[@"uploadId"];
        s.filePath = e[@"path"];
        s.urls = e[@"parts"];
        s.maxParallel = [e[@"maxParallel"] integerValue];
        s.totalBytes = [e[@"totalBytes"] longLongValue];
        s.chunkSize = [e[@"chunkSize"] longLongValue];
        s.etags = [e[@"etags"] mutableCopy];
        s.status = e[@"status"];
        s.errorMessage = [e[@"error"] length] > 0 ? e[@"error"] : nil;
        s.tempDirectory = e[@"tempDirectory"];
        s.appGroup = e[@"appGroup"];
        s.resumable = YES;
        self.sessions[s.uploadId] = s;
    }

    [self removeOrphanChunkFiles];

    RNMultipartSession *first = self.sessions.allValues.firstObject;
    NSURLSession *session = [self sessionForAppGroup:first.appGroup maxParallel:first.maxParallel > 0 ? first.maxParallel : 3];
    [session getTasksWithCompletionHandler:^(NSArray *dataTasks, NSArray *uploadTasks, NSArray *downloadTasks) {
        dispatch_async(self.queue, ^{
            for (NSURLSessionUploadTask *task in uploadTasks) {
                NSString *uploadId = nil;
                NSInteger index = -1;
                if (![self parseDescription:task.taskDescription uploadId:&uploadId index:&index]) {
                    [task cancel];
                    continue;
                }
                RNMultipartSession *s = self.sessions[uploadId];
                if (!s || ![s.status isEqualToString:STATUS_RUNNING] || index < 0 || index >= (NSInteger)s.urls.count || s.etags[index].length > 0) {
                    [task cancel];
                    continue;
                }
                s.activeTasks[@(index)] = task;
            }
            self.tasksLoaded = YES;
            if (self.sessions.count == 0) {
                [self finishBackgroundEvents];
            }
            if (self.finishEventsPending) {
                self.finishEventsPending = NO;
                [self enqueueRunningSessions];
            }
        });
    }];
}

- (void)removeOrphanChunkFiles {
    NSMutableSet<NSString *> *directories = [NSMutableSet setWithObject:[self chunkDirectoryForAppGroup:nil]];
    for (RNMultipartSession *s in self.sessions.allValues) {
        if (s.tempDirectory) [directories addObject:s.tempDirectory];
    }
    NSFileManager *fm = [NSFileManager defaultManager];
    for (NSString *directory in directories) {
        for (NSString *name in [fm contentsOfDirectoryAtPath:directory error:nil]) {
            if (![name hasPrefix:@"chunk_"] || ![name hasSuffix:@".tmp"]) continue;
            NSString *body = [name substringWithRange:NSMakeRange(6, name.length - 10)];
            NSRange separator = [body rangeOfString:@"_" options:NSBackwardsSearch];
            if (separator.location == NSNotFound) continue;
            NSString *uploadId = [body substringToIndex:separator.location];
            if (!self.sessions[uploadId]) {
                [fm removeItemAtPath:[directory stringByAppendingPathComponent:name] error:nil];
            }
        }
    }
}

- (void)restore {
    dispatch_async(self.queue, ^{
        [self restoreLocked];
    });
}

#pragma mark - URL session

- (NSURLSession *)sessionForAppGroup:(NSString *)appGroup maxParallel:(NSInteger)maxParallel {
    if (!self.urlSession) {
        NSURLSessionConfiguration *config = [NSURLSessionConfiguration backgroundSessionConfigurationWithIdentifier:SESSION_IDENTIFIER];
        config.discretionary = NO;
        config.sessionSendsLaunchEvents = YES;
        config.HTTPMaximumConnectionsPerHost = MAX(1, maxParallel);
        if (appGroup.length > 0) {
            config.sharedContainerIdentifier = appGroup;
        }
        self.urlSession = [NSURLSession sessionWithConfiguration:config delegate:self delegateQueue:nil];
    }
    return self.urlSession;
}

- (BOOL)parseDescription:(NSString *)description uploadId:(NSString **)uploadId index:(NSInteger *)index {
    NSRange range = [description rangeOfString:@":" options:NSBackwardsSearch];
    if (description.length == 0 || range.location == NSNotFound) return NO;
    *uploadId = [description substringToIndex:range.location];
    *index = [[description substringFromIndex:range.location + 1] integerValue];
    return YES;
}

#pragma mark - Background events

- (void)setBackgroundCompletionHandler:(void (^)(void))completionHandler {
    self.pendingBackgroundHandler = completionHandler;
    [self restore];
}

- (void)finishBackgroundEvents {
    void (^handler)(void) = self.pendingBackgroundHandler;
    self.pendingBackgroundHandler = nil;
    if (handler) {
        dispatch_async(dispatch_get_main_queue(), handler);
    }
}

#pragma mark - Public API

- (void)startUploadWithOptions:(NSDictionary *)options
                      resolver:(RCTPromiseResolveBlock)resolve
                      rejecter:(RCTPromiseRejectBlock)reject {
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

    dispatch_async(self.queue, ^{
        [self restoreLocked];

        RNMultipartSession *existing = self.sessions[uploadId];
        if (existing && [existing isActive]) {
            reject(@"ALREADY_EXISTS", [NSString stringWithFormat:@"Upload already in progress for %@", uploadId], nil);
            return;
        }

        NSString *appGroup = options[@"appGroup"];
        NSInteger maxParallel = [options[@"maxParallel"] integerValue] > 0 ? [options[@"maxParallel"] integerValue] : 3;

        RNMultipartSession *session = [[RNMultipartSession alloc] init];
        session.uploadId = uploadId;
        session.filePath = localPath;
        session.urls = parts;
        session.maxParallel = maxParallel;
        session.totalBytes = fileSize;
        session.chunkSize = chunkSize;
        session.appGroup = appGroup;
        session.tempDirectory = [self chunkDirectoryForAppGroup:appGroup];
        session.status = STATUS_RUNNING;
        session.resumable = options[@"resumable"] == nil ? YES : [options[@"resumable"] boolValue];
        session.resolve = resolve;
        session.reject = reject;
        session.etags = [NSMutableArray arrayWithCapacity:parts.count];
        for (NSUInteger i = 0; i < parts.count; i++) {
            [session.etags addObject:@""];
        }

        NSArray *existingEtags = options[@"existingEtags"];
        if ([existingEtags isKindOfClass:[NSArray class]]) {
            for (NSUInteger i = 0; i < existingEtags.count && i < parts.count; i++) {
                NSString *etag = existingEtags[i];
                if ([etag isKindOfClass:[NSString class]] && etag.length > 0) {
                    session.etags[i] = etag;
                }
            }
        }

        self.sessions[uploadId] = session;
        [self sessionForAppGroup:appGroup maxParallel:maxParallel];
        [self persist];

        if ([session bytesUploaded] > 0) {
            [self emitProgress:session chunkIndex:MAX(0, [session completedCount] - 1) etag:nil];
        }

        if ([session completedCount] == (NSInteger)session.urls.count) {
            [self finishSuccess:session];
        } else {
            [self enqueueRemaining:session];
        }
    });
}

- (BOOL)cancelUpload:(NSString *)uploadId {
    __block BOOL found = NO;
    dispatch_sync(self.queue, ^{
        [self restoreLocked];
        RNMultipartSession *session = self.sessions[uploadId];
        if (!session || ![session isActive]) return;
        found = YES;

        [self cancelActiveTasks:session];
        [session cleanupTempFiles];
        [self.sessions removeObjectForKey:uploadId];
        [self persist];

        [self emit:@"RNFileUploader-multipart-cancelled" body:@{
            @"uploadId": uploadId,
            @"error": @"Upload cancelled"
        } buffered:YES];

        if (session.reject) {
            session.reject(@"CANCELLED", @"Upload cancelled", nil);
        }
        session.resolve = nil;
        session.reject = nil;
    });
    return found;
}

- (BOOL)pauseUpload:(NSString *)uploadId {
    __block BOOL found = NO;
    dispatch_sync(self.queue, ^{
        [self restoreLocked];
        RNMultipartSession *session = self.sessions[uploadId];
        if (!session || ![session.status isEqualToString:STATUS_RUNNING]) return;
        found = YES;
        session.status = STATUS_PAUSED;
        [self cancelActiveTasks:session];
        [self persist];
    });
    return found;
}

- (BOOL)resumeUpload:(NSString *)uploadId {
    __block BOOL found = NO;
    dispatch_sync(self.queue, ^{
        [self restoreLocked];
        RNMultipartSession *session = self.sessions[uploadId];
        if (!session || ![session.status isEqualToString:STATUS_PAUSED]) return;
        found = YES;
        session.status = STATUS_RUNNING;
        [self persist];
        [self enqueueRemaining:session];
    });
    return found;
}

- (NSArray<NSDictionary *> *)pendingUploads {
    __block NSArray *result = @[];
    dispatch_sync(self.queue, ^{
        [self restoreLocked];
        NSMutableArray *list = [NSMutableArray array];
        for (RNMultipartSession *s in self.sessions.allValues) {
            [list addObject:@{
                @"uploadId": s.uploadId,
                @"status": s.status,
                @"progress": @([s progress]),
                @"bytesUploaded": @([s bytesUploaded]),
                @"totalBytes": @(s.totalBytes),
                @"etags": [s.etags copy],
                @"error": s.errorMessage ?: [NSNull null]
            }];
        }
        result = list;
    });
    return result;
}

- (BOOL)acknowledgeUpload:(NSString *)uploadId {
    __block BOOL removed = NO;
    dispatch_sync(self.queue, ^{
        [self restoreLocked];
        RNMultipartSession *session = self.sessions[uploadId];
        if (!session || [session isActive]) return;
        [session cleanupTempFiles];
        [self.sessions removeObjectForKey:uploadId];
        [self persist];
        removed = YES;
    });
    return removed;
}

#pragma mark - Chunk handling

- (void)cancelActiveTasks:(RNMultipartSession *)session {
    NSArray *tasks = session.activeTasks.allValues;
    [session.activeTasks removeAllObjects];
    [session.pendingRetries removeAllObjects];
    for (NSURLSessionUploadTask *task in tasks) {
        [task cancel];
    }
}

- (void)enqueueRemaining:(RNMultipartSession *)session {
    for (NSInteger i = 0; i < (NSInteger)session.urls.count; i++) {
        if (![session.status isEqualToString:STATUS_RUNNING]) return;
        if (session.etags[i].length == 0 && !session.activeTasks[@(i)] && ![session.pendingRetries containsObject:@(i)]) {
            if (![self enqueueChunk:i session:session]) return;
        }
    }
}

- (NSError *)prepareChunk:(NSInteger)index session:(RNMultipartSession *)session {
    int64_t offset = (int64_t)index * session.chunkSize;
    int64_t size = [session sizeOfChunk:index];
    NSString *tempPath = [session chunkPath:index];

    NSFileHandle *input = [NSFileHandle fileHandleForReadingAtPath:session.filePath];
    if (!input) {
        return [NSError errorWithDomain:@"RNMultipartUploader" code:-1 userInfo:@{NSLocalizedDescriptionKey: @"Cannot open file for reading"}];
    }

    NSFileManager *fm = [NSFileManager defaultManager];
    [fm removeItemAtPath:tempPath error:nil];
    if (![fm createFileAtPath:tempPath contents:nil attributes:nil]) {
        [input closeFile];
        return [NSError errorWithDomain:@"RNMultipartUploader" code:-1 userInfo:@{NSLocalizedDescriptionKey: @"Cannot create temporary chunk file"}];
    }
    NSFileHandle *output = [NSFileHandle fileHandleForWritingAtPath:tempPath];
    if (!output) {
        [input closeFile];
        return [NSError errorWithDomain:@"RNMultipartUploader" code:-1 userInfo:@{NSLocalizedDescriptionKey: @"Cannot open temporary chunk file for writing"}];
    }

    NSError *failure = nil;
    @try {
        [input seekToFileOffset:(unsigned long long)offset];
        int64_t remaining = size;
        while (remaining > 0 && !failure) {
            @autoreleasepool {
                NSData *block = [input readDataOfLength:(NSUInteger)MIN((int64_t)COPY_BLOCK_SIZE, remaining)];
                if (block.length == 0) {
                    failure = [NSError errorWithDomain:@"RNMultipartUploader" code:-1 userInfo:@{NSLocalizedDescriptionKey: [NSString stringWithFormat:@"Failed to read chunk %ld from file", (long)index]}];
                } else {
                    [output writeData:block];
                    remaining -= (int64_t)block.length;
                }
            }
        }
        [output synchronizeFile];
    } @catch (NSException *exception) {
        failure = [NSError errorWithDomain:@"RNMultipartUploader" code:-1 userInfo:@{NSLocalizedDescriptionKey: exception.reason ?: @"Exception while copying chunk"}];
    }
    [output closeFile];
    [input closeFile];

    if (failure) [fm removeItemAtPath:tempPath error:nil];
    return failure;
}

- (BOOL)enqueueChunk:(NSInteger)index session:(RNMultipartSession *)session {
    NSError *error = [self prepareChunk:index session:session];
    if (error) {
        [self failSession:session error:error];
        return NO;
    }

    NSURL *url = [NSURL URLWithString:session.urls[index]];
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
    [request setHTTPMethod:@"PUT"];
    [request setValue:@"application/octet-stream" forHTTPHeaderField:@"Content-Type"];
    [request setValue:[NSString stringWithFormat:@"%lld", (long long)[session sizeOfChunk:index]] forHTTPHeaderField:@"Content-Length"];

    NSURLSession *urlSession = [self sessionForAppGroup:session.appGroup maxParallel:session.maxParallel];
    NSURLSessionUploadTask *task = [urlSession uploadTaskWithRequest:request fromFile:[NSURL fileURLWithPath:[session chunkPath:index]]];
    task.taskDescription = [NSString stringWithFormat:@"%@:%ld", session.uploadId, (long)index];
    session.activeTasks[@(index)] = task;
    [task resume];
    return YES;
}

- (void)retryOrFail:(RNMultipartSession *)session index:(NSInteger)index error:(NSError *)error retryable:(BOOL)retryable {
    NSInteger retries = [session.retryCounts[@(index)] integerValue];
    if (!retryable || retries >= MAX_RETRIES) {
        [self failSession:session error:error];
        return;
    }

    session.retryCounts[@(index)] = @(retries + 1);
    [session.pendingRetries addObject:@(index)];
    NSTimeInterval delay = pow(2.0, (double)retries);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)), self.queue, ^{
        if (![session.pendingRetries containsObject:@(index)]) return;
        [session.pendingRetries removeObject:@(index)];
        [self enqueueRemaining:session];
    });
}

- (void)finishSuccess:(RNMultipartSession *)session {
    if (![session isActive]) return;
    session.status = STATUS_COMPLETED;
    [session cleanupTempFiles];
    [self persist];

    NSDictionary *result = @{
        @"uploadId": session.uploadId,
        @"success": @YES,
        @"etags": [session.etags copy]
    };

    [self emit:@"RNFileUploader-multipart-completed" body:result buffered:YES];

    if (session.resolve) {
        session.resolve(result);
    }
    session.resolve = nil;
    session.reject = nil;
}

- (void)failSession:(RNMultipartSession *)session error:(NSError *)error {
    if (![session isActive]) return;
    session.status = STATUS_FAILED;
    session.errorMessage = error.localizedDescription ?: @"Upload failed";
    [self cancelActiveTasks:session];
    [session cleanupTempFiles];
    [self persist];

    [self emit:@"RNFileUploader-multipart-error" body:@{
        @"uploadId": session.uploadId,
        @"error": session.errorMessage,
        @"etags": [session.etags copy]
    } buffered:YES];

    if (session.reject) {
        session.reject(@"MULTIPART_UPLOAD_ERROR", session.errorMessage, error);
    }
    session.resolve = nil;
    session.reject = nil;
}

#pragma mark - NSURLSessionTaskDelegate

- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
    dispatch_async(self.queue, ^{
        NSString *uploadId = nil;
        NSInteger index = -1;
        if (![self parseDescription:task.taskDescription uploadId:&uploadId index:&index]) return;

        RNMultipartSession *s = self.sessions[uploadId];
        if (!s || ![s.status isEqualToString:STATUS_RUNNING] || index < 0 || index >= (NSInteger)s.urls.count) return;

        NSURLSessionUploadTask *tracked = s.activeTasks[@(index)];
        if (tracked && tracked != task) return;
        if (!tracked && error.code == NSURLErrorCancelled) return;

        [s.activeTasks removeObjectForKey:@(index)];
        [[NSFileManager defaultManager] removeItemAtPath:[s chunkPath:index] error:nil];

        if (error) {
            [self retryOrFail:s index:index error:error retryable:YES];
            return;
        }

        NSHTTPURLResponse *response = (NSHTTPURLResponse *)task.response;
        NSInteger status = response.statusCode;
        if (status < 200 || status >= 300) {
            BOOL retryable = status >= 500 || status == 408 || status == 429;
            NSString *msg = [NSString stringWithFormat:@"HTTP status %ld on chunk %ld", (long)status, (long)index];
            [self retryOrFail:s index:index error:[NSError errorWithDomain:@"RNMultipartUploader" code:status userInfo:@{NSLocalizedDescriptionKey: msg}] retryable:retryable];
            return;
        }

        NSString *etag = [response valueForHTTPHeaderField:@"ETag"] ?: @"";
        etag = [etag stringByTrimmingCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@"\""]];
        if (etag.length == 0) {
            [self failSession:s error:[NSError errorWithDomain:@"RNMultipartUploader" code:-1 userInfo:@{NSLocalizedDescriptionKey: [NSString stringWithFormat:@"Missing ETag on chunk %ld", (long)index]}]];
            return;
        }

        s.etags[index] = etag;
        [self persist];
        [self emitProgress:s chunkIndex:index etag:etag];

        if ([s completedCount] == (NSInteger)s.urls.count) {
            [self finishSuccess:s];
        }
    });
}

- (void)enqueueRunningSessions {
    for (RNMultipartSession *s in self.sessions.allValues) {
        if ([s.status isEqualToString:STATUS_RUNNING]) {
            [self enqueueRemaining:s];
        }
    }
}

- (void)URLSessionDidFinishEventsForBackgroundURLSession:(NSURLSession *)session {
    dispatch_async(self.queue, ^{
        if (self.tasksLoaded) {
            [self enqueueRunningSessions];
        } else {
            self.finishEventsPending = YES;
        }
    });
}

@end
