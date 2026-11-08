const handlers = [
    require('./authenticate'),
    require('./exchange'),
    require('./hiscores'),
    require('./web-content'),
    require('./player'),
    require('./pvp'), // ARSC Wilderness clans and PvP record
    require('./world')
];

const handlerMethods = {};

for (const handler of handlers) {
    for (const handlerName of Object.keys(handler)) {
        handlerMethods[handlerName] = handler[handlerName];
    }
}

module.exports = handlerMethods;
