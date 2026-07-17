// ES module entry (ADR-0002 expand step). The legacy scripts below were
// written as classic scripts sharing one global scope, so import order here
// must mirror the old <script> tag order in index.html. Each file ends with a
// transitional `window.*` bridge for the symbols other files (or inline HTML
// handlers) reach across module boundaries.
import "./three-global.js";

import "./locales/en.js";
import "./locales/zh.js";
import "./locales/pt-BR.js";
import "./locales/de.js";
import "./locales/fr.js";
import "./locales/ko.js";
import "./locales/ru.js";
import "./locales/it.js";
import "./locales/nep.js";
import "./i18n.js";

import "./config.js";
import "./state.js";
import "./entities/Request.js";
import "./entities/Service.js";
import "./services/SoundService.js";
import "./tutorial.js";
import "./campaign/objectives.js";
import "./campaign/diagram.js";
import "./campaign/levels.js";
import "./campaign/campaign.js";
import "../game.js";
