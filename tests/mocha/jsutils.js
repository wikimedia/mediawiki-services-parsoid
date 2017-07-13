'use strict';

/* eslint no-unused-expressions: off */
/* global describe, it, Promise */
require("chai").should();

var JSUtils = require('../../lib/utils/jsutils').JSUtils;

describe('JSUtils', function() {
	describe('deepFreeze', function() {
		it('should freeze the passed object', function() {
			var frozenObject = {
				anObject: 'withProperty'
			};

			JSUtils.deepFreeze(frozenObject);

			frozenObject.should.be.frozen;
		});

		it('should recursively freeze all properties of the passed object', function() {
			var frozenObject = {
				anObject: {
					withMultiple: {
						nestedProperties: {}
					}
				}
			};

			JSUtils.deepFreeze(frozenObject);

			frozenObject.should.be.frozen;
			frozenObject.anObject.should.be.frozen;
			frozenObject.anObject.withMultiple.should.be.frozen;
			frozenObject.anObject.withMultiple.nestedProperties.should.be.frozen;
		});

		it('should not freeze prototype properties', function() {
			var SomeProtoType = function() {};
			SomeProtoType.prototype.protoProperty = {};

			var TestObject = function() {
				SomeProtoType.call(this);
				this.testProperty = {};
			};

			TestObject.prototype = Object.create(SomeProtoType.prototype);

			var frozenTestObject = new TestObject();

			JSUtils.deepFreeze(frozenTestObject);

			frozenTestObject.should.be.frozen;
			frozenTestObject.testProperty.should.be.frozen;
			frozenTestObject.protoProperty.should.not.be.frozen;
		});

		it('should not freeze getters', function() {
			var frozenObjectWithGetter = {
				get foo() {
					return {};
				},
				bar: {},
			};

			JSUtils.deepFreeze(frozenObjectWithGetter);

			frozenObjectWithGetter.foo.should.not.be.frozen;
			frozenObjectWithGetter.bar.should.be.frozen;
		});
	});

	describe('deepFreezeButIgnore', function() {
		it('should not freeze properties specified in the exclusion list', function() {
			var frozenObject = {
				propertyToFreeze: {},
				propertyToExclude: {}
			};

			var exclusionList = {
				propertyToExclude: true
			};

			JSUtils.deepFreezeButIgnore(frozenObject, exclusionList);

			frozenObject.propertyToFreeze.should.be.frozen;
			frozenObject.propertyToExclude.should.not.be.frozen;
		});
	});

	describe('lastItem', function() {
		it('should return the penultimate item when passed a non-empty array', function() {
			var myArray = [5, 6];

			JSUtils.lastItem(myArray).should.equal(6);
		});

		it('should throw error when passed an empty array', function() {
			var functionWithEmptyArray = function() {
				return JSUtils.lastItem([]);
			};

			functionWithEmptyArray.should.throw;
		});
	});

	describe('mapObject', function() {
		it('should generate correct map from the provided object', function() {
			var map = JSUtils.mapObject({
				foo: 'bar',
				bar: 5
			});

			map.should.be.a('Map');
			map.get('foo').should.equal('bar');
			map.get('bar').should.equal(5);
		});
	});

	describe('freezeMap', function() {
		it('should prevent mutating the map', function() {
			var map = new Map([['foo', 'bar']]);

			var addToMap = function() {
				map.set('baz', 'quux');
			};

			var clearMap = function() {
				map.clear();
			};

			var removeFromMap = function() {
				map.remove('foo');
			};

			JSUtils.freezeMap(map);

			addToMap.should.throw(TypeError);
			clearMap.should.throw(TypeError);
			removeFromMap.should.throw(TypeError);
		});

		it('should freeze map contents when specified', function() {
			var anObject = {};
			var map = new Map();

			map.set('foo', anObject);

			JSUtils.freezeMap(map, true);

			map.get('foo').should.be.frozen;
		});

		it('should not freeze map contents when not specified', function() {
			var anObject = {};
			var map = new Map();

			map.set('foo', anObject);

			JSUtils.freezeMap(map);

			map.get('foo').should.not.be.frozen;
		});
	});

	describe('freezeSet', function() {
		it('should prevent mutating the set', function() {
			var set = new Set(['foo', 'bar']);

			var addToSet = function() {
				set.add('quux');
			};

			var clearSet = function() {
				set.clear();
			};

			var removeFromSet = function() {
				set.remove('foo');
			};

			JSUtils.freezeSet(set);

			addToSet.should.throw(TypeError);
			clearSet.should.throw(TypeError);
			removeFromSet.should.throw(TypeError);
		});

		it('should freeze set contents when specified', function() {
			var anObject = {};
			var set = new Set();

			set.add(anObject);

			JSUtils.freezeSet(set, true);

			set.forEach(function(entry) {
				entry.should.be.frozen;
			});
		});

		it('should not freeze set contents when not specified', function() {
			var anObject = {};
			var set = new Set();

			set.add(anObject);

			JSUtils.freezeSet(set);

			set.forEach(function(entry) {
				entry.should.not.be.frozen;
			});
		});
	});

	describe('deepEquals', function() {
		describe('when called with two objects with recursively equal properties', function() {
			it('should consider them equal if their constructor matches', function() {
				var anObject = {
					foo: {
						bar: {
							baz: 'quux'
						}
					}
				};

				var otherObject = {
					foo: {
						bar: {
							baz: 'quux'
						}
					}
				};

				JSUtils.deepEquals(anObject, otherObject).should.be.true;
			});

			it('should not consider them equal if their constructor differs', function() {
				function AnObject() {
					this.foo = 'bar';
				}

				function OtherObject() {
					this.foo = 'bar';
				}

				var anObject = new AnObject();
				var otherObject = new OtherObject();

				JSUtils.deepEquals(anObject, otherObject).should.be.false;
			});
		});

		describe('when called with two objects with differing property keys', function() {
			it('should not consider them equal', function() {
				var anObject = {};
				var otherObject = {
					foo: 'bar'
				};

				JSUtils.deepEquals(anObject, otherObject).should.be.false;
			});
		});

		describe('when called with two objects with identical keys but different values', function() {
			it('should not consider them equal', function() {
				var anObject = {
					foo: 420
				};
				var otherObject = {
					foo: 'bar'
				};

				JSUtils.deepEquals(anObject, otherObject).should.be.false;
			});
		});

		describe('when called with two primitives', function() {
			it('should consider them equal if their value is equal', function() {
				JSUtils.deepEquals(5, 5).should.be.true;
				JSUtils.deepEquals('bar', 'bar').should.be.true;
			});

			it('should not consider them equal if their value is not equal', function() {
				JSUtils.deepEquals(3, 4).should.be.false;
				JSUtils.deepEquals('bar', 'foo').should.be.false;
			});
		});

		describe('when called with an object and a primitive', function() {
			it('should not consider them equal', function() {
				JSUtils.deepEquals({}, 5).should.be.false;
				JSUtils.deepEquals(5, {}).should.be.false;

				JSUtils.deepEquals({}, 'str').should.be.false;
				JSUtils.deepEquals('str', {}).should.be.false;
			});
		});
	});
});
