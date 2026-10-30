// Entry point: the Safety Log is the main stage; the live camera and neighborhood feeds are add-ons.

import { startSafety } from './safety/app.js';
import { startLive, reportLiveError } from './live/live.js';

startSafety();
startLive().catch(reportLiveError);
