#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

NS_ASSUME_NONNULL_BEGIN

@interface RNMultipartUploader : NSObject

+ (instancetype)sharedInstance;
+ (NSString *)sessionIdentifier;

- (void)setEventEmitter:(nullable void (^)(NSString *eventName, id body))eventEmitter;
- (void)restore;
- (void)setBackgroundCompletionHandler:(void (^)(void))completionHandler;
- (void)finishBackgroundEvents;

- (void)startUploadWithOptions:(NSDictionary *)options
                      resolver:(RCTPromiseResolveBlock)resolve
                      rejecter:(RCTPromiseRejectBlock)reject;

- (BOOL)cancelUpload:(NSString *)uploadId;
- (BOOL)pauseUpload:(NSString *)uploadId;
- (BOOL)resumeUpload:(NSString *)uploadId;
- (NSArray<NSDictionary *> *)pendingUploads;
- (BOOL)acknowledgeUpload:(NSString *)uploadId;

@end

NS_ASSUME_NONNULL_END
