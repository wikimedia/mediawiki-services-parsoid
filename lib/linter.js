/*
*  Logger backend for linter.
*  This backend filters out logging messages with Logtype "lint/*" and for now log them
*  to the console. later, we might save them into a Database.
*/

"use strict";

var request = require('request');

var Linter = function (){

    this.buffer = [];

};

Linter.prototype.logLintOutput = function(logData, cb) {

    if (this.buffer.length > 0) {
        if (!logData._env.conf.parsoid.linterAPI) {
            console.log(this.buffer);
        } else {
            request.post(logData._env.conf.parsoid.linterAPI,
                        {json : this.buffer},
                        function (error, response, body) {
                            if (!error && response.statusCode === 200) {
                                console.log(body);
                            }
                        });
        }
        this.buffer = [];
        return;
    } else { console.log("No Issues found"); }
};

Linter.prototype.linterBackend = function (logData, cb) {

    try {
        var logType = logData.logType,
            src = logData.logObject[0],
            dsr = logData.logObject[1],
            msg = {};

        var re = /lint\/(.*)/,
            wiki = logData._env.conf.wiki.iwp;

        msg.type = logType.match(re)[1];
        msg.location = logData.locationMsg();
        msg.wiki = wiki;
        msg.page = logData._env.page.name;
        msg.revision = logData._env.page.meta.revision.revid;
        msg.wikiurl = logData._env.conf.parsoid.interwikiMap[wiki].split('/w/')[0];

        if (dsr) {
            msg.dsr = dsr;
        }

        if (logType === 'lint/fostered' || logType === 'lint/Mixed-template') {
            msg.src = src;
        } else if (dsr) {
            msg.src = src.substring(dsr[0], dsr[1]);
        }

        if (logData.logObject[2]) {
            var tip = logData.logObject[2];
            msg.tips = tip;
        }

        this.buffer.push(msg);

    } catch (e) {
        console.error("Error in linterBackend: " + e);
        return;
    } finally {
        cb();
    }

};

if (typeof module === "object") {
    module.exports.Linter = Linter;
}
