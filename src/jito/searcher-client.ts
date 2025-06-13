import {Keypair} from '@solana/web3.js';
import {
  ChannelCredentials,
  ChannelOptions,
  ClientReadableStream,
  ServiceError,
  status,
} from '@grpc/grpc-js';

import {BundleResult} from './block-eng-bundle';
import {
  ConnectedLeadersResponse,
  GetTipAccountsResponse,
  NextScheduledLeaderResponse,
  SearcherServiceClient,
  SendBundleRequest,
  SendBundleResponse,
  SlotList,
} from './searcher';
// import {authInterceptor, AuthProvider} from './auth';
import {Bundle} from './types';

export class SearcherClientError extends Error {
  constructor(public code: status, message: string, public details: string) {
    super(`${message}${details ? `: ${details}` : ''}`);
    this.name = 'SearcherClientError';
  }
}

export class SearcherClient {
  private client: SearcherServiceClient;
  private readonly retryOptions: Readonly<{
    maxRetries: number;
    baseDelay: number;
    maxDelay: number;
    factor: number;
  }>;

  constructor(client: SearcherServiceClient) {
    this.client = client;
    this.retryOptions = Object.freeze({
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 10000,
      factor: 2,
    });
  }

  private handleError(e: ServiceError): never {
    const errorDetails = e.details || 'No additional details provided';
    
    switch (e.code) {
      case status.OK:
        throw new SearcherClientError(e.code, 'Unexpected OK status in error', errorDetails);
      case status.CANCELLED:
        throw new SearcherClientError(e.code, 'The operation was cancelled', errorDetails);
      case status.UNKNOWN:
        throw new SearcherClientError(e.code, 'Unknown error', errorDetails);
      case status.INVALID_ARGUMENT:
        throw new SearcherClientError(e.code, 'Invalid argument provided', errorDetails);
      case status.DEADLINE_EXCEEDED:
        throw new SearcherClientError(e.code, 'Deadline exceeded', errorDetails);
      case status.NOT_FOUND:
        throw new SearcherClientError(e.code, 'Requested entity not found', errorDetails);
      case status.ALREADY_EXISTS:
        throw new SearcherClientError(e.code, 'The entity already exists', errorDetails);
      case status.PERMISSION_DENIED:
        throw new SearcherClientError(e.code, 'Lacking required permission', errorDetails);
      case status.RESOURCE_EXHAUSTED:
        throw new SearcherClientError(e.code, 'Resource has been exhausted', errorDetails);
      case status.FAILED_PRECONDITION:
        throw new SearcherClientError(e.code, 'Operation rejected, system not in correct state', errorDetails);
      case status.ABORTED:
        throw new SearcherClientError(e.code, 'The operation was aborted', errorDetails);
      case status.OUT_OF_RANGE:
        throw new SearcherClientError(e.code, 'Operation attempted past the valid range', errorDetails);
      case status.UNIMPLEMENTED:
        throw new SearcherClientError(e.code, 'Operation not implemented or supported', errorDetails);
      case status.INTERNAL:
        throw new SearcherClientError(e.code, 'Internal error', errorDetails);
      case status.UNAVAILABLE:
        let unavailableMessage = 'The service is currently unavailable';
        if (errorDetails.includes('upstream connect error or disconnect/reset before headers')) {
          unavailableMessage = 'Service unavailable: Envoy overloaded';
        } else if (errorDetails.toLowerCase().includes('dns resolution failed')) {
          unavailableMessage = 'Service unavailable: DNS resolution failed';
        } else if (errorDetails.toLowerCase().includes('ssl handshake failed')) {
          unavailableMessage = 'Service unavailable: SSL handshake failed';
        } else if (errorDetails.toLowerCase().includes('connection refused')) {
          unavailableMessage = 'Service unavailable: Connection refused';
        } else if (errorDetails.toLowerCase().includes('network unreachable')) {
          unavailableMessage = 'Service unavailable: Network is unreachable';
        } else if (errorDetails.toLowerCase().includes('timeout')) {
          unavailableMessage = 'Service unavailable: Connection timed out';
        }
        throw new SearcherClientError(e.code, unavailableMessage, errorDetails);
      case status.DATA_LOSS:
        throw new SearcherClientError(e.code, 'Unrecoverable data loss or corruption', errorDetails);
      case status.UNAUTHENTICATED:
        throw new SearcherClientError(e.code, 'Request not authenticated', errorDetails);
      default:
        throw new SearcherClientError(status.UNKNOWN, `Unexpected error: ${e.message}`, errorDetails);
    }
  }

  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    retries = 0
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (retries >= this.retryOptions.maxRetries || !this.isRetryableError(error)) {
        throw error;
      }

      const delay = Math.min(
        this.retryOptions.baseDelay * Math.pow(this.retryOptions.factor, retries),
        this.retryOptions.maxDelay
      );
      console.warn(`Operation failed. Retrying in ${delay}ms... (Attempt ${retries + 1} of ${this.retryOptions.maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, delay));

      return this.retryWithBackoff(operation, retries + 1);
    }
  }

  private isRetryableError(error: any): boolean {
    if (error instanceof SearcherClientError) {
      if (error.code === status.UNAVAILABLE) {
        // Don't retry certain types of UNAVAILABLE errors
        const nonRetryableMessages = [
          'Service unavailable: DNS resolution failed',
          'Service unavailable: SSL handshake failed'
        ];
        return !nonRetryableMessages.some(msg => error.message.includes(msg));
      }
      const retryableCodes = [
        status.UNAVAILABLE,
        status.RESOURCE_EXHAUSTED,
        status.DEADLINE_EXCEEDED,
      ];
      return retryableCodes.includes(error.code);
    }
    return false;
  }

   /**
   * Submits a bundle to the block-engine.
   *
   * @param bundle - The Bundle object to be sent.
   * @returns A Promise that resolves to the bundle's UUID (string) on successful submission.
   * @throws A ServiceError if there's an issue with the server while sending the bundle.
   */
  async sendBundle(bundle: Bundle): Promise<string> {
    return this.retryWithBackoff(() => {
      return new Promise<string>((resolve, reject) => {
        this.client.sendBundle(
          { bundle } as SendBundleRequest,
          (e: ServiceError | null, resp: SendBundleResponse) => {
            if (e) {
              reject(this.handleError(e));
            } else {
              resolve(resp.uuid);
            }
          }
        );
      });
    });
  }

  /**
   * Retrieves tip accounts from the server.
   *
   * @returns A Promise that resolves to an array of account strings (usually public keys).
   * @throws A ServiceError if there's an issue with the server while fetching tip accounts.
   */
  async getTipAccounts(): Promise<string[]> {
    return this.retryWithBackoff(() => {
      return new Promise<string[]>((resolve, reject) => {
        this.client.getTipAccounts(
          {},
          (e: ServiceError | null, resp: GetTipAccountsResponse) => {
            if (e) {
              reject(this.handleError(e));
            } else {
              resolve(resp.accounts);
            }
          }
        );
      });
    });
  }

   /**
   * Retrieves connected leaders (validators) from the server.
   *
   * @returns A Promise that resolves to a map, where keys are validator identity keys (usually public keys), and values are SlotList objects.
   * @throws A ServiceError if there's an issue with the server while fetching connected leaders.
   */
  async getConnectedLeaders(): Promise<{[key: string]: SlotList}> {
    return this.retryWithBackoff(() => {
      return new Promise((resolve, reject) => {
        this.client.getConnectedLeaders(
          {},
          async (e: ServiceError | null, resp: ConnectedLeadersResponse) => {
            if (e) {
              reject(this.handleError(e));
            } else {
              resolve(resp.connectedValidators);
            }
          }
        );
      });
    });
  }

  /**
   * Returns the next scheduled leader connected to the block-engine.
   *
   * @returns A Promise that resolves with an object containing:
   *        - currentSlot: The current slot number the backend is on
   *        - nextLeaderSlot: The slot number of the next scheduled leader
   *        - nextLeaderIdentity: The identity of the next scheduled leader
   * @throws A ServiceError if there's an issue with the server while fetching the next scheduled leader.
   */
  async getNextScheduledLeader(): Promise<{
    currentSlot: number;
    nextLeaderSlot: number;
    nextLeaderIdentity: string;
  }> {
    return this.retryWithBackoff(() => {
      return new Promise((resolve, reject) => {
        this.client.getNextScheduledLeader(
          {
            regions: [],
          },
          async (e: ServiceError | null, resp: NextScheduledLeaderResponse) => {
            if (e) {
              reject(this.handleError(e));
            } else {
              resolve(resp);
            }
          }
        );
      });
    });
  }

  /**
   * Triggers the provided callback on BundleResult updates.
   *
   * @param successCallback - A callback function that receives the BundleResult updates
   * @param errorCallback - A callback function that receives the stream error (Error)
   * @returns A function to cancel the subscription
   */
  onBundleResult(
    successCallback: (bundleResult: BundleResult) => void,
    errorCallback: (e: Error) => void
  ): () => void {
    const stream: ClientReadableStream<BundleResult> =
      this.client.subscribeBundleResults({});

    stream.on('readable', () => {
      const msg = stream.read(1);
      if (msg) {
        successCallback(msg);
      }
    });
    stream.on('error', e => {
      errorCallback(new Error(`Stream error: ${e.message}`));
    });

    return () => stream.cancel();
  }

   /**
   * Yields on bundle results.
   *
   * @param onError - A callback function that receives the stream error (Error)
   * @returns An async generator that yields BundleResult updates
   */
  async *bundleResults(
    onError: (e: Error) => void
  ): AsyncGenerator<BundleResult> {
    const stream: ClientReadableStream<BundleResult> =
      this.client.subscribeBundleResults({});

    stream.on('error', e => {
      onError(e);
    });

    for await (const bundleResult of stream) {
      yield bundleResult;
    }
  }
}

/**
 * Creates and returns a SearcherClient instance.
 *
 * @param url - The URL of the SearcherService
 * @param authKeypair - Optional Keypair authorized for the block engine
 * @param grpcOptions - Optional configuration options for the gRPC client
 * @returns SearcherClient - An instance of the SearcherClient
 */
// export const searcherClient = (
//   url: string,
//   authKeypair?: Keypair,
//   grpcOptions?: Partial<ChannelOptions>
// ): SearcherClient => {
//   if (authKeypair) {
//     const authProvider = new AuthProvider(
//       new AuthServiceClient(url, ChannelCredentials.createSsl()),
//       authKeypair
//     );
//     const client = new SearcherServiceClient(
//       url,
//       ChannelCredentials.createSsl(),
//       {interceptors: [authInterceptor(authProvider)], ...grpcOptions}
//     );
//     return new SearcherClient(client);
//   } else {
//     return new SearcherClient(
//       new SearcherServiceClient(
//         url,
//         ChannelCredentials.createSsl(),
//         grpcOptions
//       )
//     );
//   }
// };