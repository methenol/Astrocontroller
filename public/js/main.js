/* Astrocontroller UI: vanilla ES modules, no build step. Each screen registers its own handlers on import. */
import { layoutBoot } from './shell.js';
import { startVideo } from './video.js';
import './telescope.js';
import './controls.js';
import './switches.js';
import './duty.js';
import './chat.js';
import { startWeather } from './tonight.js';
import { startGuardWatch } from './weather.js';
import './plan.js';
import './journal.js';
import './database.js';
import './stellarium.js';
import './research.js';
import './album.js';
import './library.js';
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
