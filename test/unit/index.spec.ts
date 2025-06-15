import { expect, fake, sinon } from "@infra-blocks/test";
import {
  ErrorWorker,
  ErrorWorkerEvents,
  initProcessHandlers,
  ShutdownWorker,
  ShutdownWorkerEvents,
} from "../../src/index.js";
import { Logger } from "@infra-blocks/logger-interface";
import { checkNotNull } from "@infra-blocks/checks";

describe("index", function () {
  describe(ShutdownWorker.name, function () {
    describe("construction", function () {
      it("should properly initialize some fields", function () {
        const worker = ShutdownWorker.create();
        expect(worker.isFinished()).to.be.false;
      });
    });

    describe("start", function () {
      it("should start and finish properly without handlers", function (done) {
        const worker = ShutdownWorker.create();
        worker.on("finished", () => {
          expect(worker.isFinished()).to.be.true;
          done();
        });
        worker.start();
      });
      it("should skip if already running", function (done) {
        const worker = ShutdownWorker.create();
        let innerResolve: (value?: unknown) => void;
        let callCount = 0;
        worker.addHandler("dummy", () => {
          callCount++;
          if (callCount > 1) {
            throw new Error(`should not be called twice`);
          }

          return new Promise((resolve) => {
            innerResolve = resolve;
          });
        });
        worker.on("finished", () => {
          expect(worker.isFinished()).to.be.true;
          done();
        });
        worker.start();
        worker.start();
        innerResolve!();
      });
      it("should skip if already finished", function (done) {
        const handler = sinon.fake();
        const worker = ShutdownWorker.create();
        worker.addHandler("fake", handler);
        worker.on("finished", () => {
          expect(handler).to.have.been.calledOnce;
          worker.start();
          // Not the strictest of tests, but has a chance to capture an error.
          expect(worker.isFinished()).to.be.true;
          done();
        });
        worker.start();
      });
    });
    describe("handlers", function () {
      it("should be run in reverse order", function (done) {
        const worker = ShutdownWorker.create();
        const firstHandler = sinon.fake();
        const secondHandler = sinon.fake();
        const thirdHandler = sinon.fake();

        worker.addHandler("first", firstHandler);
        worker.addHandler("second", secondHandler);
        worker.addHandler("third", thirdHandler);

        worker.on("finished", () => {
          sinon.assert.callOrder(thirdHandler, secondHandler, firstHandler);
          expect(firstHandler).to.have.been.calledOnce;
          expect(secondHandler).to.have.been.calledOnce;
          expect(thirdHandler).to.have.been.calledOnce;
          expect(worker.isFinished()).to.be.true;
          done();
        });
        worker.start();
      });
      it("should call the error handler on error and keep processing the shutdown hooks", function (done) {
        const worker = ShutdownWorker.create();
        const error = new Error("uh oh");
        const firstFake = sinon.fake();
        const secondFake = sinon.fake.rejects(error);
        const thirdFake = sinon.fake();

        worker.addHandler("first", firstFake);
        worker.addHandler("second", secondFake);
        worker.addHandler("third", thirdFake);

        const errorHandler = sinon.fake();
        worker.on("error", errorHandler);
        worker.on("finished", () => {
          sinon.assert.callOrder(thirdFake, secondFake, firstFake);
          expect(firstFake).to.have.been.calledOnce;
          expect(secondFake).to.have.been.calledOnce;
          expect(thirdFake).to.have.been.calledOnce;
          expect(errorHandler).to.have.been.calledOnce;
          expect(worker.isFinished()).to.be.true;
          done();
        });
        worker.start();
      });
    });
    describe("addHandler", function () {
      it("should throw when adding a handler with a preexisting name", function () {
        const worker = ShutdownWorker.create();
        worker.addHandler("one", sinon.fake());
        expect(() => worker.addHandler("one", sinon.fake())).to.throw();
      });
    });
  });
  describe(ErrorWorker.name, function () {
    describe("construction", function () {
      it("should properly initialize some fields", function () {
        const worker = ErrorWorker.create();
        expect(worker.hasBeenCalled()).to.be.false;
        expect(worker.isFinished()).to.be.false;
      });
    });

    describe("handleError", function () {
      it("should work without handlers", function (done) {
        const worker = ErrorWorker.create();
        worker.on("finished", () => {
          expect(worker.hasBeenCalled()).to.be.true;
          expect(worker.isFinished()).to.be.true;
          done();
        });
        worker.handleError(new Error("hello?"));
      });
      it("should call the provided handlers in the expected order", function (done) {
        const worker = ErrorWorker.create();

        const firstHandler = sinon.fake();
        const secondHandler = sinon.fake();
        const thirdHandler = sinon.fake();

        worker.addHandler("first", firstHandler);
        worker.addHandler("second", secondHandler);
        worker.addHandler("third", thirdHandler);

        worker.on("finished", () => {
          sinon.assert.callOrder(firstHandler, secondHandler, thirdHandler);
          expect(firstHandler).to.have.been.calledOnce;
          expect(secondHandler).to.have.been.calledOnce;
          expect(thirdHandler).to.have.been.calledOnce;

          expect(worker.hasBeenCalled()).to.be.true;
          expect(worker.isFinished()).to.be.true;
          done();
        });
        worker.handleError(new Error("hello?"));
      });
      it("should tolerate concurrent access and remove failing handlers", function (done) {
        const worker = ErrorWorker.create();
        const originalError = new Error("hello?");
        const midExecutionError = new Error("fucked up?");

        const firstHandler = sinon.fake();
        // Once it throws, it will be removed!
        const secondHandler = sinon.fake.throws(midExecutionError);
        const thirdHandler = sinon.fake();

        worker.addHandler("first", firstHandler);
        worker.addHandler("second", secondHandler);
        worker.addHandler("third", thirdHandler);

        worker.on("finished", () => {
          sinon.assert.callOrder(
            firstHandler,
            secondHandler,
            firstHandler,
            thirdHandler,
            thirdHandler
          );

          const firstHandlerCalls = firstHandler.getCalls();
          expect(firstHandlerCalls).to.have.length(2);
          expect(firstHandlerCalls[0].firstArg).to.equal(originalError);
          expect(firstHandlerCalls[1].firstArg).to.equal(midExecutionError);
          expect(secondHandler).to.have.been.calledOnceWith(originalError);
          const thirdHandlerCalls = thirdHandler.getCalls();
          expect(thirdHandlerCalls).to.have.length(2);
          // The order actually doesn't matter, but with the current implementation, it'll be in that order.
          expect(thirdHandlerCalls[0].firstArg).to.equal(midExecutionError);
          expect(thirdHandlerCalls[1].firstArg).to.equal(originalError);
          expect(thirdHandler).to.have.been.calledTwice;

          expect(worker.hasBeenCalled()).to.be.true;
          expect(worker.isFinished()).to.be.true;
          done();
        });

        worker.handleError(originalError);
      });
    });
    describe("addHandler", function () {
      it("should throw for a preexisting handler name", function () {
        const worker = ErrorWorker.create();
        worker.addHandler("one", sinon.fake());
        expect(() => worker.addHandler("one", sinon.fake())).to.throw();
      });
    });
  });
  describe("ProcessHandlers", function () {
    describe(initProcessHandlers.name, function () {
      it("should register to all three process events", function () {
        const errorWorkerOn = sinon.fake();
        const errorWorker = fake<ErrorWorker>({
          on: errorWorkerOn,
        });
        const shutdownWorkerOn = sinon.fake();
        const shutdownWorker = fake<ShutdownWorker>({
          on: shutdownWorkerOn,
        });
        const processOn = sinon.fake();
        const process = fake<NodeJS.Process>({
          on: processOn,
        });
        initProcessHandlers({
          process,
          errorWorker,
          shutdownWorker,
        });

        // It should register on all three node events.
        const onCalls = processOn.getCalls();
        expect(onCalls).to.have.length(3);
        // The order doesn't matter, but that's how it is now.
        expect(onCalls[0].firstArg).to.equal("uncaughtException");
        expect(onCalls[1].firstArg).to.equal("unhandledRejection");
        expect(onCalls[2].firstArg).to.equal("beforeExit");
        // It also registers on worker events, but we'll test that later.
      });
    });
    describe("on", function () {
      describe("error", function () {
        it("should dispatch to error worker", function () {
          const process = fake<NodeJS.Process>({
            on: sinon.fake(),
          });
          const shutdownWorker = ShutdownWorker.create();
          const addHandler = sinon.fake();
          const errorWorker = fake<ErrorWorker>({
            addHandler,
            on: sinon.fake(),
          });
          const processHandlers = initProcessHandlers({
            process,
            errorWorker,
            shutdownWorker,
          });
          const handler = sinon.fake();
          processHandlers.on("error", "test", handler);
          expect(addHandler).to.have.been.calledOnceWith("test", handler);
        });
      });
      describe("shutdown", function () {
        it("should dispatch to shutdown worker", function () {
          const process = fake<NodeJS.Process>({
            on: sinon.fake(),
          });
          const addHandler = sinon.fake();
          const shutdownWorker = fake<ShutdownWorker>({
            addHandler,
            on: sinon.fake(),
          });
          const errorWorker = ErrorWorker.create();
          const processHandlers = initProcessHandlers({
            process,
            errorWorker,
            shutdownWorker,
          });
          const handler = sinon.fake();
          processHandlers.on("shutdown", "test", handler);
          expect(addHandler).to.have.been.calledOnceWith("test", handler);
        });
      });
    });
    describe("setLogger", function () {
      it("should set the logger and dispatch to workers", function () {
        const process = fake<NodeJS.Process>({
          on: sinon.fake(),
        });
        const errorWorkerSetLogger = sinon.fake();
        const errorWorker = fake<ErrorWorker>({
          on: sinon.fake(),
          setLogger: errorWorkerSetLogger,
        });
        const shutdownWorkerSetLogger = sinon.fake();
        const shutdownWorker = fake<ShutdownWorker>({
          on: sinon.fake(),
          setLogger: shutdownWorkerSetLogger,
        });
        const processHandlers = initProcessHandlers({
          process,
          errorWorker,
          shutdownWorker,
        });

        const logger = fake<Logger>({});
        processHandlers.setLogger(logger);

        expect(errorWorkerSetLogger).to.have.been.calledOnceWith(logger);
        expect(shutdownWorkerSetLogger).to.have.been.calledOnceWith(logger);
      });
    });
    describe("process events", function () {
      type ProcessOn = typeof global.process.on;
      type ProcessOnEvent = Parameters<ProcessOn>[0];

      function getHandlerForProcessEvent(
        on: sinon.SinonSpy,
        event: ProcessOnEvent
      ) {
        const calls = on.getCalls();
        const call = checkNotNull(
          calls.find((call) => call.firstArg === event)
        ) as sinon.SinonSpyCall<Parameters<ProcessOn>, ReturnType<ProcessOn>>;
        return call.args[1];
      }

      function initFakeProcessHandlers(params: {
        handleError: sinon.SinonSpy;
        start: sinon.SinonSpy;
        processOn: sinon.SinonSpy;
      }) {
        const { handleError, start, processOn } = params;
        const errorWorker = fake<ErrorWorker>({
          on: sinon.fake(),
          handleError,
        });
        const shutdownWorker = fake<ShutdownWorker>({
          on: sinon.fake(),
          start,
        });
        const process = fake<NodeJS.Process>({
          on: processOn,
        });
        initProcessHandlers({
          process,
          errorWorker,
          shutdownWorker,
        });
      }

      describe("uncaughtException", function () {
        it("should trigger error and shutdown handlers ", function () {
          const handleError = sinon.fake();
          const start = sinon.fake();
          const processOn = sinon.fake();
          initFakeProcessHandlers({ handleError, start, processOn });

          // Check that we haven't called the workers yet.
          expect(handleError).to.not.have.been.called;
          expect(start).to.not.have.been.called;
          // Get and trigger the handler on the nodejs process' event.
          const handler = getHandlerForProcessEvent(
            processOn,
            "uncaughtException"
          );
          const error = new Error("woopsy");
          handler(error);

          // This should have called errorWorker.handlerError() and shutdownWorker.start()
          expect(handleError).to.have.been.calledOnceWith(error);
          expect(start).to.have.been.calledOnce;
        });
      });
      describe("unhandledRejection", function () {
        it("should trigger error and shutdown handlers ", function () {
          const handleError = sinon.fake();
          const start = sinon.fake();
          const processOn = sinon.fake();
          initFakeProcessHandlers({ handleError, start, processOn });

          // Check that we haven't called the workers yet.
          expect(handleError).to.not.have.been.called;
          expect(start).to.not.have.been.called;
          // Get and trigger the handler on the nodejs process' event.
          const handler = getHandlerForProcessEvent(
            processOn,
            "unhandledRejection"
          );
          const error = new Error("woopsy");
          handler(error);

          // This should have called errorWorker.handlerError() and shutdownWorker.start()
          expect(handleError).to.have.been.calledOnceWith(error);
          expect(start).to.have.been.calledOnce;
        });
      });
      describe("beforeExit", function () {
        it("should trigger shutdown handlers only", function () {
          const handleError = sinon.fake();
          const start = sinon.fake();
          const processOn = sinon.fake();
          initFakeProcessHandlers({ handleError, start, processOn });

          // Check that we haven't called the workers yet.
          expect(handleError).to.not.have.been.called;
          expect(start).to.not.have.been.called;
          // Get and trigger the handler on the nodejs process' event.
          const handler = getHandlerForProcessEvent(processOn, "beforeExit");
          const error = new Error("woopsy");
          handler(error);

          // This should have called errorWorker.handlerError() and shutdownWorker.start()
          expect(handleError).to.not.have.been.called;
          expect(start).to.have.been.calledOnce;
        });
      });
    });
    describe("finished events", function () {
      function initFakeProcessHandlers(params: {
        processExit: sinon.SinonSpy;
        errorWorkerOn?: sinon.SinonSpy;
        errorWorkerIsFinished?: sinon.SinonSpy;
        errorWorkerHasBeenCalled?: sinon.SinonSpy;
        shutdownWorkerOn?: sinon.SinonSpy;
        shutdownWorkerIsFinished?: sinon.SinonSpy;
      }) {
        const {
          errorWorkerOn = sinon.fake(),
          errorWorkerIsFinished = sinon.fake(),
          errorWorkerHasBeenCalled = sinon.fake(),
          shutdownWorkerOn = sinon.fake(),
          shutdownWorkerIsFinished = sinon.fake(),
          processExit,
        } = params;
        const errorWorker = fake<ErrorWorker>({
          on: errorWorkerOn,
          isFinished: errorWorkerIsFinished,
          hasBeenCalled: errorWorkerHasBeenCalled,
        });
        const shutdownWorker = fake<ShutdownWorker>({
          on: shutdownWorkerOn,
          isFinished: shutdownWorkerIsFinished,
        });
        const process = fake<NodeJS.Process>({
          on: sinon.fake(),
          exit: processExit as unknown as typeof global.process.exit,
        });
        initProcessHandlers({
          process,
          errorWorker,
          shutdownWorker,
        });
      }

      function getHandler<R>(spy: sinon.SinonSpy, event: string): R {
        const calls = spy.getCalls();
        const call = checkNotNull(
          calls.find((call) => call.firstArg === event)
        );
        return call.args[1] as R;
      }

      it("it should call process exit 0 if the shutdown worker is finished and the error worker was never called", function () {
        const shutdownWorkerOn = sinon.fake();
        const processExit = sinon.fake();
        initFakeProcessHandlers({
          errorWorkerHasBeenCalled: sinon.fake.returns(false),
          shutdownWorkerOn,
          processExit,
        });

        // Trigger the finished event from the shutdown worker.
        expect(processExit).to.not.have.been.called;
        const handler = getHandler<ShutdownWorkerEvents["finished"]>(
          shutdownWorkerOn,
          "finished"
        );
        handler();

        expect(processExit).to.have.been.calledOnceWith(0);
      });
      it("it should call process exit 1 if the shutdown worker is finished and the error worker is finished", function () {
        const shutdownWorkerOn = sinon.fake();
        const processExit = sinon.fake();
        initFakeProcessHandlers({
          errorWorkerIsFinished: sinon.fake.returns(true),
          errorWorkerHasBeenCalled: sinon.fake.returns(true),
          shutdownWorkerOn,
          processExit,
        });

        // Trigger the finished event from the shutdown worker.
        expect(processExit).to.not.have.been.called;
        const handler = getHandler<ShutdownWorkerEvents["finished"]>(
          shutdownWorkerOn,
          "finished"
        );
        handler();

        expect(processExit).to.have.been.calledOnceWith(1);
      });
      it("should not call process exit if the shutdown worker is finished but the error worker isn't", function () {
        const shutdownWorkerOn = sinon.fake();
        const processExit = sinon.fake();
        initFakeProcessHandlers({
          errorWorkerIsFinished: sinon.fake.returns(false),
          errorWorkerHasBeenCalled: sinon.fake.returns(true),
          shutdownWorkerOn,
          processExit,
        });

        // Trigger the finished event from the shutdown worker.
        expect(processExit).to.not.have.been.called;
        const handler = getHandler<ShutdownWorkerEvents["finished"]>(
          shutdownWorkerOn,
          "finished"
        );
        handler();

        expect(processExit).to.not.have.been.called;
      });
      it("it should call process exit 1 if the error worker is finished and the shutdown worker is finished", function () {
        const errorWorkerOn = sinon.fake();
        const processExit = sinon.fake();
        initFakeProcessHandlers({
          errorWorkerOn,
          shutdownWorkerIsFinished: sinon.fake.returns(true),
          processExit,
        });

        // Trigger the finished event from the error worker.
        expect(processExit).to.not.have.been.called;
        const handler = getHandler<ErrorWorkerEvents["finished"]>(
          errorWorkerOn,
          "finished"
        );
        handler();

        expect(processExit).to.have.been.calledOnceWith(1);
      });
      it("should not call process exit if the error worker is finished but the shutdown worker isn't", function () {
        const errorWorkerOn = sinon.fake();
        const processExit = sinon.fake();
        initFakeProcessHandlers({
          errorWorkerOn,
          shutdownWorkerIsFinished: sinon.fake.returns(false),
          processExit,
        });

        // Trigger the finished event from the error worker.
        expect(processExit).to.not.have.been.called;
        const handler = getHandler<ErrorWorkerEvents["finished"]>(
          errorWorkerOn,
          "finished"
        );
        handler();

        expect(processExit).to.not.have.been.called;
      });
    });
  });
});
