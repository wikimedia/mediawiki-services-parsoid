/*
*  Logger backend for linter.
*  This backend filters out logging messages with Logtype "lint/*" and for now log them
*  to the console. later, we might save them into a Database.
*/

"use strict";

var linterBackend = function (logData, cb) {

    try {

        var logType = logData.logType,
            src = logData.logObject[0],
            dsr = logData.logObject[1],
            msg = '';


        msg = "Type : " + logType;

        msg += "\nLocation : " + logData.locationMsg();

        if (logType === 'lint/fostered') {
            msg += "\nSnippet : " + src;
        } else if (logType === 'lint/Mixed-template') {
            msg += "\nTemplates Used: \n" + src;
        } else {
            msg += "\nSnippet : " + src.substring(dsr[0], dsr[1]);
        }

        if (dsr) {
            msg += "\nDSR Info : " + dsr;
        }

        if (logData.logObject[2]) {
            var tip = logData.logObject[2];
            msg += "\nTips : " + tip;
        }

        console.warn(msg);

    } catch (e) {
        console.error("Error in linterBackend: " + e);
        return;
    } finally {
        cb();
    }

};

if (typeof module === "object") {
    module.exports.Linter = linterBackend;
}
