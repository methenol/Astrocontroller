/* Astrocontroller UI: vanilla ES modules, no build step. Each screen registers its own handlers on import. */
import { layoutBoot } from './shell.js';
import { startVideo } from './video.js';
import './telescope.js';
import './controls.js';
import './duty.js';
import './chat.js';
import { startWeather } from './tonight.js';
import './database.js';
import './album.js';
import './library.js';
import './skills.js';
import './logs.js';
import { connect } from './socket.js';

startVideo();
connect();
startWeather();
layoutBoot();
