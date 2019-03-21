<?php
declare( strict_types = 1 );

namespace Parsoid\Utils;

class EventEmitter {
	private $listeners = [];

	/**
	 * Fire an event and trigger all registered listeners
	 *
	 * @param string $eventName Event to fire
	 * @param mixed ...$args Arguments to pass to the event listeners
	 */
	public function emit( string $eventName, ...$args ): void {
		foreach ( $this->listeners[$eventName] ?? [] as $listener ) {
			$listener( ...$args );
		}
	}

	/**
	 * Add a listener for an event
	 *
	 * @param string $eventName
	 * @param callable $listener
	 */
	public function addListener( string $eventName, callable $listener ): void {
		$this->listeners[$eventName][] = $listener;
	}
}
