# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2025-07-03

### Added

- `initProcessHandlers` additionally hooks onto signals `SIGTERM` and `SIGINT` by 
default. They simply dispatch to `gracefulShutdown` to create a more coherent experience.

## [0.2.0] - 2025-07-03

### Changed

- Defaulting to using the `NullLogger` as opposed to the `ConsoleLogger`. The convention
across libraries so far has been to opt into component logging and not opt-out. So, just
extending the convention to this module as well. The main reason for this discrepancy
is that the `ProcessHandlers` were made before the `NullLogger` existed.

### Fixed

- A small bug where the default handler was using the looger at construction instead of
whatever the instance's logger appears to be when being invoked. For example, if the
logger changed by calling `setLogger`, it wouldn't affect the default handler's logger.
Now, they are in sync.

## [0.1.0] - 2025-06-15

### Added

- First implementation of the process handlers!

[0.1.0]: https://github.com/infra-blocks/ts-process-handlers/releases/tag/v0.1.0
