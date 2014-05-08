"use strict";
var profiler = require('v8-profiler');

/**
 * Simplistic V8 CPU profiler wrapper, WIP
 *
 * Usage:
 * npm install v8-profiler
 *
 * var profiler = require('./profiler');
 * profiler.start('parse');
 * <some computation>
 * var prof = profiler.stop('parse');
 * fs.writeFileSync('parse.cpuprofile', JSON.stringify(prof));
 *
 * Now you can load parse.cpuprofile into chrome, or (much nicer) convert it
 * to calltree format using https://github.com/phleet/chrome2calltree:
 *
 * chrome2calltree -i parse.cpuprofile -o parse.calltree
 * kcachegrind parse.calltree
 *
 * Then use kcachegrind to visualize the callgrind file.
 */

/**
V8 prof node structure:
{ childrenCount: 3,
  callUid: 3550382514,
  selfSamplesCount: 0,
  totalSamplesCount: 7706,
  selfTime: 0,
  totalTime: 7960.497092032271,
  lineNumber: 0,
  scriptName: '',
  functionName: '(root)',
  getChild: [Function: getChild] }

sample cpuprofile (from Chrome):
{
  "functionName":"(root)",
  "scriptId":"0",
  "url":"",
  "lineNumber":0,
  "columnNumber":0,
  "hitCount":0,
  "callUID":4142747341,
  "children":[{"functionName":"(program)","scriptId":"0","url":"","lineNumber":0,"columnNumber":0,"hitCount":3,"callUID":912934196,"children":[],"deoptReason":"","id":2},{"functionName":"(idle)","scriptId":"0","url":"","lineNumber":0,"columnNumber":0,"hitCount":27741,"callUID":176593847,"children":[],"deoptReason":"","id":3}],"deoptReason":"","id":1}
*/

function convertProfNode (node) {
	var res = {
		functionName: node.functionName,
		lineNumber: node.lineNumber,
		callUID: node.callUid,
		hitCount: node.selfSamplesCount,
		url: node.scriptName,
		children: []
	};
	for (var i = 0; i < node.childrenCount; i++) {
		res.children.push(convertProfNode(node.getChild(i)));
	}
	return res;
}

function prof2cpuprofile (prof) {
	return {
		head: convertProfNode(prof.topRoot),
		startTime: 0,
		endTime: prof.topRoot.totalTime,
	};
}

module.exports = {
	// Start profiling
	start: function(name) {
		return profiler.startProfiling(name);
	},
	// End profiling
	stop: function(name) {
		return prof2cpuprofile(profiler.stopProfiling(name));
	}
};
