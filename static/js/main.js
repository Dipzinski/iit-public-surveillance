// Entry point: the Safety Log is the main stage; the live cameras and feeds are add-ons
// that wait for the archive where they need it (campus reports in the stream, the comparison card).

import { startSafety } from './safety/app.js';
import { startLive, reportLiveError } from './live/live.js';
import { initPalette } from './palette.js';

const ready = startSafety();
startLive(ready).catch(reportLiveError);
initPalette();
