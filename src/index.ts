import { EventEmitter } from "events";
import TypedEmitter from "typed-emitter";
import { ErrorHandler } from "@infra-blocks/types";
import { Logger } from "@infra-blocks/logger-interface";
import { NullLogger } from "@infra-blocks/null-logger";

/**
 * A shutdown handler is an asynchronous function whose returned is not looked at.
 */
export type ShutdownHandler = () => Promise<unknown>;

/**
 * Events that can be subscribed to on the {@link ShutdownWorker} class.
 */
export type ShutdownWorkerEvents = {
  error: (error: unknown) => void;
  finished: () => void;
};

/**
 * States of the worker state machine.
 */
enum ShutdownWorkerState {
  Idle,
  Started,
  Finished,
}

/**
 * A class centralizing the processing of shutdown handlers.
 *
 * It is meant to tolerate concurrent access and run each handler only once, then report termination.
 * Shutdown handlers are always run in reverse order and sequentially.
 *
 * Errors are forwarded to the error handler provided. An error handler should always be provided, otherwise
 * the NodeJS event emitter's default handler will throw, which could interrupt the flow of things.
 *
 * When an error handler is provided, shutdown handler errors are forwarded to the handler and the shutdown
 * process resumes.
 *
 * This class also emits the "finished" event. This event will only be sent once and after having run
 * all shutdown handlers.
 *
 * This class is not meant to be used directly by client code, it's meant to be used via the {@link ProcessHandlersImpl}.
 */
export class ShutdownWorker {
  /**
   * LIFO container of shutdown handlers.
   * @private
   */
  private readonly shutdownHandlers: Map<string, ShutdownHandler>;
  private logger: Logger;
  private state: ShutdownWorkerState;
  private emitter: TypedEmitter.default<ShutdownWorkerEvents>;

  private constructor(params: { logger: Logger }) {
    const { logger } = params;
    this.logger = logger;
    this.shutdownHandlers = new Map();
    this.state = ShutdownWorkerState.Idle;
    this.emitter =
      new EventEmitter() as TypedEmitter.default<ShutdownWorkerEvents>;
  }

  // TODO: include an optional timeout on shutdown handlers.
  /**
   * Adds a handler to run on shutdown.
   *
   * Handlers are run in reverse order: last one added is first one run.
   * Handler names need to be unique. If a handler with the same name already
   * exists, this function will throw.
   *
   * @param name - The human friendly name of the handler.
   * @param handler - The handler.
   */
  addHandler(name: string, handler: ShutdownHandler) {
    if (this.shutdownHandlers.has(name)) {
      throw new Error(`shutdown handler ${name} already present`);
    }
    this.shutdownHandlers.set(name, handler);
  }

  /**
   * Returns true if the worker has finished running the provided handlers.
   */
  isFinished() {
    return this.state === ShutdownWorkerState.Finished;
  }

  /**
   * Subscribe to events emitted by this worker.
   *
   * Errors include errors thrown by shutdown handlers.
   *
   * @param event - The event. Either "error", or "finished".
   * @param handler - The corresponding handler.
   */
  on<T extends keyof ShutdownWorkerEvents>(
    event: T,
    handler: ShutdownWorkerEvents[T]
  ) {
    this.emitter.on(event, handler);
  }

  /**
   * Starts the worker (initiates the running of shutdown handlers).
   *
   * Does nothing if already started or already finished.
   */
  start() {
    this.logger.info("shutdown worker start request");
    switch (this.state) {
      case ShutdownWorkerState.Idle:
        this.state = ShutdownWorkerState.Started;
        this.runShutdownHandlers();
        break;
      case ShutdownWorkerState.Started:
        this.logger.info("already shutting down, skipping");
        break;
      case ShutdownWorkerState.Finished:
        this.logger.info("shutdown worker already finished, skipping");
        break;
    }
  }

  /**
   * Sets the class's logger.
   *
   * @param logger - The logger.
   */
  setLogger(logger: Logger) {
    this.logger = logger;
  }

  private runShutdownHandlers() {
    void this.runShutdownHandlersAsync();
  }

  private async runShutdownHandlersAsync() {
    this.logger.debug("running shutdown handlers");
    try {
      // The handlers are a stack, so last in is first out.
      const handlers = Array.from(this.shutdownHandlers.entries()).reverse();

      for (const [name, handler] of handlers) {
        await this.runShutdownHandler(name, handler);
      }
    } finally {
      this.finished();
    }
  }

  private async runShutdownHandler(
    name: string,
    handler: ShutdownHandler
  ): Promise<void> {
    try {
      this.logger.info(`running shutdown handler::${name}`);
      await handler();
    } catch (err) {
      this.logger.error(`error running shutdown handler::${name}`);
      this.emitter.emit("error", err);
    }
  }

  private finished() {
    this.state = ShutdownWorkerState.Finished;
    this.emitter.emit("finished");
  }

  static create(options?: { logger?: Logger }): ShutdownWorker {
    const { logger = NullLogger.create() } = options || {};
    return new ShutdownWorker({ logger });
  }
}

/**
 * Events that can be subscribed to on the {@link ErrorWorker} class.
 */
export type ErrorWorkerEvents = {
  finished: () => void;
};

/**
 * States of the worker state machine.
 */
enum ErrorWorkerState {
  Idle,
  Running,
  Finished,
}

const DEFAULT_ERROR_HANDLER_NAME = "__DEFAULT__";

/**
 * This class encapsulates the logic required to handle process errors.
 *
 * It tolerates concurrent access and is meant to run through errors only once.
 *
 * Handlers are executed in the order they are provided, from first to last. When a handler throws, it is removed
 * from the handlers and won't execute for future errors. Its error is then submitted to the beginning of the
 * handlers chain.
 *
 * It emits the "finished" event when all handlers were exhausted and no further processing of errors are required.
 * Note that this event can be sent more than once in the lifetime of this object.
 */
export class ErrorWorker {
  /**
   * FIFO container of error handlers.
   * @private
   */
  private readonly errorHandlers: Map<string, ErrorHandler>;
  private logger: Logger;
  private state: ErrorWorkerState;
  private callCounter: number;
  private readonly emitter: TypedEmitter.default<ErrorWorkerEvents>;

  private constructor(params: { logger: Logger }) {
    const { logger } = params;
    this.logger = logger;
    this.errorHandlers = new Map();
    this.state = ErrorWorkerState.Idle;
    this.callCounter = 0;
    this.emitter =
      new EventEmitter() as TypedEmitter.default<ErrorWorkerEvents>;

    // The default handler is to simply log using this class's logger.
    this.errorHandlers.set(DEFAULT_ERROR_HANDLER_NAME, (err) =>
      this.logger.error("%s", err)
    );
  }

  /**
   * Adds a handler to run on error.
   *
   * Handlers are run in the order they are provided: first one added is first one run.
   * Handler names need to be unique. If a handler with the same name already
   * exists, this function will throw.
   *
   * @param name - The human friendly name of the handler.
   * @param handler - The handler.
   */
  addHandler(name: string, handler: ErrorHandler) {
    if (name === DEFAULT_ERROR_HANDLER_NAME) {
      throw new Error(`invalid reserved handler name ${name}`);
    }
    if (this.errorHandlers.has(name)) {
      throw new Error(`error handler ${name} already present`);
    }
    // We remove the default handler as soon as another one is added.
    this.errorHandlers.delete(DEFAULT_ERROR_HANDLER_NAME);
    this.errorHandlers.set(name, handler);
  }

  /**
   * Subscribe to events emitted by this worker.
   *
   * @param event - The event, only support for "finished" right now.
   * @param handler - The corresponding handler.
   */
  on<T extends keyof ErrorWorkerEvents>(
    event: T,
    handler: ErrorWorkerEvents[T]
  ) {
    this.emitter.on(event, handler);
  }

  /**
   * This function runs all handler for the provided error.
   *
   * Because errors coming from NodeJS process handlers are "unknown", this function will attempt
   * to convert the value to an error first before passing it on to the handlers.
   *
   * @param error - The error to handle.
   */
  handleError(error?: unknown): void {
    this.state = ErrorWorkerState.Running;
    this.callCounter++;
    try {
      this.runErrorHandlers(toError(error));
    } finally {
      this.callCounter--;
      if (this.callCounter === 0) {
        this.finished();
      }
    }
  }

  /**
   * Returns true if {@link handleError} has been called at least once.
   */
  hasBeenCalled() {
    return this.state !== ErrorWorkerState.Idle;
  }

  /**
   * Returns true if the worker isn't currently processing errors.
   */
  isFinished() {
    return this.state === ErrorWorkerState.Finished;
  }

  /**
   * Sets the class's logger.
   *
   * @param logger - The logger.
   */
  setLogger(logger: Logger) {
    this.logger = logger;
  }

  private finished() {
    this.state = ErrorWorkerState.Finished;
    this.emitter.emit("finished");
  }

  private runErrorHandlers(error: Error) {
    this.logger.debug("running error handlers");
    for (const [name, handler] of this.errorHandlers) {
      this.runErrorHandler(name, handler, toError(error));
    }
  }

  private runErrorHandler(name: string, handler: ErrorHandler, error: Error) {
    try {
      this.logger.debug(`running error handler::${name}`);
      handler(error);
      return error;
    } catch (err) {
      this.logger.error(`error running error handler::${name}`);
      this.removeErrorHandler(name);
      this.handleError(err);
    }
  }

  private removeErrorHandler(name: string) {
    this.logger.error(`removing error handler::${name}`);
    this.errorHandlers.delete(name);
  }

  static create(options?: { logger?: Logger }): ErrorWorker {
    const { logger = NullLogger.create() } = options || {};
    return new ErrorWorker({ logger });
  }
}

export interface ProcessHandlersEvents {
  error: ErrorHandler;
  shutdown: ShutdownHandler;
}

/**
 * This interface encapsulates common logic for running error handling middlewares and shutdown hooks.
 *
 * Registered shutdown handlers are *always* run in the reverse order that they have been registered (the last
 * one registered is the first one being run). They are run sequentially. If a shutdown handler fails,
 * the process calls the error handlers chain and continues with the remaining shutdown handlers.
 *
 * The error handlers are run sequentially in the *same order that they have been registered*. When a handler
 * throws, it is removed from the handler chain and the thrown error is passed on to the new chain.
 * The original error will get processed by all handlers coming after the faulty one as if nothing happened.
 *
 * There is a single default error handler that logs errors using the provided logger. It is removed as soon
 * as the first handler is provided. Therefore, you may want to add your own logger handler as the first handler.
 *
 * When any error is encountered at any moment, this class will take note of it. When all shutdown hooks
 * have executed, if an error was encountered, then {@link process.exit} will be called with 1. 0 otherwise. Note that calling
 * process.exit(0) can only occur in the case of a graceful shutdown with successful shutdown handlers.
 */
export interface ProcessHandlers {
  /**
   * Sets the logger.
   *
   * @param logger - The new logger to use.
   */
  setLogger(logger: Logger): void;

  /**
   * Subscribe to events on this class.
   *
   * @param event - The event to subscribe to, either "error" or "shutdown".
   * @param name - The name of the handler
   * @param handler - The actual handler.
   */
  on<K extends keyof ProcessHandlersEvents>(
    event: K,
    name: string,
    handler: ProcessHandlersEvents[K]
  ): void;

  /**
   * Runs all shutdown handlers and exits the process.
   *
   * Process exit is called at the end. The return code is 0 when all shutdown handlers executed successfully, false
   * otherwise.
   *
   * This can be called explicitly when shutdown should occur and the event loop hasn't been exhausted yet.
   */
  gracefulShutdown(): void;

  /**
   * Runs all error handlers, then the shutdown handlers, then exits the process with return code 1.
   *
   * This shouldn't be called explicitly by the user, but it is provided in case not all uses cases are covered
   * with the handlers registered.
   *
   * @param error - The error, as received by the {@link process} events.
   */
  crashShutdown(error?: unknown): void;
}

class ProcessHandlersImpl implements ProcessHandlers {
  private readonly shutdownWorker: ShutdownWorker;
  private readonly errorWorker: ErrorWorker;

  private readonly process: NodeJS.Process;
  private logger: Logger;

  constructor(params: {
    logger: Logger;
    process: NodeJS.Process;
    shutdownWorker: ShutdownWorker;
    errorWorker: ErrorWorker;
  }) {
    const { logger, process, shutdownWorker, errorWorker } = params;
    this.logger = logger;
    this.process = process;
    this.shutdownWorker = shutdownWorker;
    this.errorWorker = errorWorker;

    this.shutdownWorker.on("error", (error) =>
      this.errorWorker.handleError(error)
    );

    this.shutdownWorker.on("finished", () => {
      this.logger.debug("shutdown worker finished");
      if (!this.errorWorker.hasBeenCalled()) {
        this.logger.debug("no error encountered, exiting with 0");
        return this.process.exit(0);
      }
      if (this.errorWorker.isFinished()) {
        this.logger.debug("error worker also finished, exiting with 1");
        return this.process.exit(1);
      }
    });
    this.errorWorker.on("finished", () => {
      this.logger.debug("error worker finished");
      if (this.shutdownWorker.isFinished()) {
        this.logger.debug("shutdown worker also finished, exiting with 1");
        this.process.exit(1);
      } else {
        this.logger.debug("waiting on shutdown worker to finish");
      }
    });
  }

  setLogger(logger: Logger): void {
    this.logger = logger;
    this.shutdownWorker.setLogger(logger);
    this.errorWorker.setLogger(logger);
  }

  on<K extends keyof ProcessHandlersEvents>(
    event: K,
    name: string,
    handler: ProcessHandlersEvents[K]
  ): void {
    switch (event) {
      case "error":
        this.errorWorker.addHandler(name, handler as ErrorHandler);
        break;
      case "shutdown":
        this.shutdownWorker.addHandler(name, handler as ShutdownHandler);
        break;
    }
  }

  gracefulShutdown(): void {
    this.logger.debug("graceful shutdown");
    this.shutdownWorker.start();
  }

  crashShutdown(error?: unknown): void {
    this.logger.debug("crash shutdown");

    this.errorWorker.handleError(error);
    this.shutdownWorker.start();
  }

  /**
   * Registers handlers on Node.js process.
   *
   * This should only be called once and there should only ever be one instance of {@link ProcessHandlersImpl} that does
   * that.
   *
   * It registers on 3 events:
   * - uncaughtException
   * - unhandledRejection
   * - beforeExit
   * and 2 signals:
   * - SIGTERM
   * - SIGINT
   *
   * For the first 2 events (programmatic errors), the listener is an internal function that will make sure to run
   * the error and the shutdown handlers before terminating the process. It inevitably calls process.exit(1).
   *
   * The beforeExit handler just calls {@link gracefulShutdown}. This happens on normal execution when the event
   * loop has been exhausted.
   *
   * The 2 signals are handled the same way as the `beforeExit` event: they call {@link gracefulShutdown}.
   */
  hookOntoNodeProcess(): void {
    this.process.on("uncaughtException", (err) => this.crashShutdown(err));
    this.process.on("unhandledRejection", (err) => this.crashShutdown(err));
    // If we have emptied the event loop normally, we still run the shutdown handlers.
    this.process.on("beforeExit", () => this.gracefulShutdown());
    this.process.on("SIGTERM", () => this.gracefulShutdown());
    this.process.on("SIGINT", () => this.gracefulShutdown());
  }
}

/**
 * Creates a {@link ProcessHandlersImpl} and hooks it into Node.js native events.
 *
 * This should only be called once and there should only ever be one instance of {@link ProcessHandlersImpl} that exists
 * in a Node.js process.
 *
 * It registers on 3 events:
 * - uncaughtException
 * - unhandledRejection
 * - beforeExit
 * and 2 signals:
 * - SIGTERM
 * - SIGINT
 *
 * For the first 2 events (programmatic errors), the listener is an internal function that will make sure to run
 * the error and the shutdown handlers before terminating the process. It inevitably calls process.exit(1).
 *
 * The beforeExit handler just calls {@link gracefulShutdown}. This happens on normal execution when the event
 * loop has been exhausted.
 *
 * The 2 signals are handled the same way as the `beforeExit` event: they call {@link gracefulShutdown}.
 *
 * @param options.logger - The logger to use. Defaults to {@link console}
 * @param options.process - The Node.js process, defaults to {@link global.process}
 */
export function initProcessHandlers(options?: {
  logger?: Logger;
  process?: NodeJS.Process;
  errorWorker?: ErrorWorker;
  shutdownWorker?: ShutdownWorker;
}): ProcessHandlersImpl {
  const {
    logger = NullLogger.create(),
    process = global.process,
    errorWorker = ErrorWorker.create({ logger }),
    shutdownWorker = ShutdownWorker.create({ logger }),
  } = options || {};

  const handlers = new ProcessHandlersImpl({
    logger,
    process,
    shutdownWorker,
    errorWorker,
  });
  handlers.hookOntoNodeProcess();
  return handlers;
}

function toError(reason?: unknown): Error {
  if (reason != null) {
    return reason instanceof Error ? reason : new Error(JSON.stringify(reason));
  }

  return new Error("unexpected undefined reason");
}
