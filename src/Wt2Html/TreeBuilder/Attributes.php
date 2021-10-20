<?php

namespace Wikimedia\Parsoid\Wt2Html\TreeBuilder;

use Wikimedia\Parsoid\DOM\Document;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\RemexHtml\Tokenizer\PlainAttributes;

class Attributes extends PlainAttributes {
	private $document;

	/**
	 * @param Document $document
	 * @param array $data
	 */
	public function __construct( Document $document, $data = [] ) {
		$this->document = $document;
		parent::__construct( $data );
	}

	public function clone() {
		if ( isset( $this->data[DOMDataUtils::DATA_OBJECT_ATTR_NAME] ) ) {
			$newAttrs = $this->data;
			$data = DOMDataUtils::getBag( $this->document )->getObject(
				$this->data[DOMDataUtils::DATA_OBJECT_ATTR_NAME] );
			$newData = $data->clone();
			$newAttrs[DOMDataUtils::DATA_OBJECT_ATTR_NAME] =
				DOMDataUtils::stashObjectInDoc( $this->document, $newData );
			return new self( $this->document, $newAttrs );
		} else {
			return $this;
		}
	}
}
