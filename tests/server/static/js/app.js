/*global initialCommitList, updateCommitList, $:false */
$(function() {
	"use strict";

	initialCommitList();

	$('.revisions input').on('click', function(){
		var name = $(this).attr('name');
		updateCommitList.bind(this, name).call();
	});
});