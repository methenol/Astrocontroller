/* Astrocontroller UI: vanilla ES modules, no build step. Each screen registers its own handlers on import. */
import { layoutBoot } from './shell.js';
import { startVideo } from './video.js';
import './telescope.js';
import './controls.js';
import './tools.js';
import './camera-settings.js';
import './stacking.js';
import './pointing.js';
import './switches.js';
import './duty.js';
import './chat.js';
import { startWeather } from './tonight.js';
import { startGuardWatch } from './weather.js';
import './plan.js';
import './journal.js';
import './database.js';
import './calendar.js';
import './stellarium.js';
import './research.js';
import './research-library.js';
import './album.js';
import './library.js';
import './acquisition.js';
import './skills.js';
import './logs.js';
// after every screen: its 'telescope' listener runs last and keeps unsupported controls off
import './capabilities.js';
import './hub-link.js';
import { connect } from './socket.js';

startVideo();
connect();
startWeather();
startGuardWatch();
layoutBoot();
// every module loaded and ran: the profile hub's frame watchdog reloads a frame that never gets here
document.documentElement.dataset.booted = '1';
