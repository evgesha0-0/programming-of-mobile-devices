import { createStartupEvent } from './app.js';

process.stdout.write(`${JSON.stringify(createStartupEvent())}\n`);
