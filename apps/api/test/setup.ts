import { Logger } from '@nestjs/common';

// Keep test output readable; run with DEBUG=1 to see the app's logs.
if (!process.env.DEBUG) Logger.overrideLogger(false);
