<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\PP\Processors;

use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;

class WrapSectionsTplInfo {
	/** @var Element */
	public $first;
	/** @var string */
	public $about;
	/** @var Node */
	public $last;
	/** @var Node[] */
	public $rtContentNodes = [];
	/** @var Section|null */
	public $firstSection;
	/** @var Section|null */
	public $lastSection;
}
