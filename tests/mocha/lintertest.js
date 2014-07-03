'use strict';
/*global describe, it, Promise*/

require("es6-shim");
var should = require("chai").should();

var MWParserEnvironment = require('../../lib/mediawiki.parser.environment.js' ).MWParserEnvironment,
	Util = require('../../lib/mediawiki.Util.js').Util,
	ParsoidConfig = require('../../lib/mediawiki.ParsoidConfig' ).ParsoidConfig;

describe( 'Linter Tests', function() {
	var parsoidConfig = new ParsoidConfig( null,  { defaultWiki: 'enwiki' } );
	parsoidConfig.linting = true;

	var parse = function( wt, cb ) {
		MWParserEnvironment.getParserEnv( parsoidConfig, null, 'enwiki', 'Main_Page', null, function ( err, env ) {

			if ( err !== null ) {
				console.error( err );
				return cb( err );
			}

			var utilCB = function ( src, err, doc ) {

				if ( err ) {
					env.log( "error", err );
					return cb( err );
				}
				cb( null, env.linter.buffer );
			};

			env.setPageSrcInfo( wt );
			Util.parse( env, utilCB, null, wt, null );
		});
	};

	var parseWT = function( wt ) {
		return new Promise( function( resolve, reject ) {
			parse( wt, function( err, result ) {
				if ( err ) {
					reject( err );
				} else {
					resolve( result );
				}
			});
		});
	};

	describe( '#Issues', function() {
		it( 'should not lint any issues', function() {
			return parseWT( 'foo' ).then( function( result ) {
				return result.should.be.empty;
			});
		});
		it( 'should lint missing end tags correctly', function() {
			return parseWT( '<div>foo' ).then( function ( result ) {
				result.should.have.length( 1 );
				result[0].should.have.a.property( "type", "missing-end-tag" );
				result[0].should.have.a.property( "wiki", "enwiki" );
				result[0].dsr.should.include.members( [ 0, 8, 5, 0 ] );
				result[0].should.have.a.property( "src", "<div>foo" );
			});
		});
		it( 'should lint stripped tags correctly', function() {
			return parseWT( 'foo</div>' ).then( function ( result ) {
				result.should.have.length( 1 );
				result[0].should.have.a.property( "type", "strippedTag" );
				result[0].should.have.a.property( "wiki", "enwiki" );
				result[0].dsr.should.include.members( [ 3, 9, null, null ] );
				result[0].should.have.a.property( "src", "</div>" );
			});
		});
		it( 'should lint obsolete tags correctly', function() {
			return parseWT( '<big>foo</big>bar' ).then( function ( result ) {
				result.should.have.length( 1 );
				result[0].should.have.a.property( "type", "ObsoleteTag" );
				result[0].should.have.a.property( "wiki", "enwiki" );
				result[0].dsr.should.include.members( [ 0, 14, 5, 6 ] );
				result[0].should.have.a.property( "src", "<big>foo</big>" );
			});
		});
		it( 'should lint fostered content correctly', function() {
			return parseWT( '{|\nfoo\n|-\n| bar\n|}' ).then( function ( result ) {
				result.should.have.length( 1 );
				result[0].should.have.a.property( "type", "fostered" );
				result[0].should.have.a.property( "wiki", "enwiki" );
				result[0].dsr.should.include.members( [ 0, 18, 2, 2 ] );
				result[0].should.have.a.property( "src", "foo" );
			});
		});
		it('should lint ignored table attributes Correctly', function(done){
			return parseWT( '{|\n|- foo\n|bar\n|}' ).done( function ( result ) {
				result.should.have.length( 1 );
				result[0].should.have.a.property("type", "ignored-table-attr");
				result[0].should.have.a.property("wiki", "enwiki");
				result[0].dsr.should.include.members([ 3, 14, 6, 0 ]);
				result[0].should.have.a.property("src", "|- foo\n|bar");
			});
		});
		it( 'should lint  Bogus image options correctly', function() {
			return parseWT( '[[file:a.jpg|foo|bar]]' ).then( function ( result ) {
				result.should.have.length( 1 );
				result[0].should.have.a.property( "type", "BogusImageOptions" );
				result[0].should.have.a.property( "wiki", "enwiki" );
				result[0].dsr.should.include.members( [ 0, 22, null, null ] );
				result[0].should.have.a.property( "src", "[[file:a.jpg|foo|bar]]" );
			});
		});
	});
});
