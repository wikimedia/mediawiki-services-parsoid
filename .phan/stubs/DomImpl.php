<?php
# For the purpose of phan, we're always using IDLeDOM.  That avoids the
# type variance/co-variance issues involved in teaching phan about our
# subclasses, and also keeps us from accessing any private implementation
# details of Dodo.
#
# This list should match the one in DomImpl.php in the root.

class_alias( "Wikimedia\\IDLeDOM\\Attr", "Wikimedia\\Parsoid\\DOM\\Attr" );
class_alias( "Wikimedia\\IDLeDOM\\CharacterData", "Wikimedia\\Parsoid\\DOM\\CharacterData" );
class_alias( "Wikimedia\\IDLeDOM\\Comment", "Wikimedia\\Parsoid\\DOM\\Comment" );
class_alias( "Wikimedia\\IDLeDOM\\Document", "Wikimedia\\Parsoid\\DOM\\Document" );
class_alias( "Wikimedia\\IDLeDOM\\DocumentFragment", "Wikimedia\\Parsoid\\DOM\\DocumentFragment" );
class_alias( "Wikimedia\\IDLeDOM\\DocumentType", "Wikimedia\\Parsoid\\DOM\\DocumentType" );
class_alias( "Wikimedia\\IDLeDOM\\DOMException", "Wikimedia\\Parsoid\\DOM\\DOMException" );
class_alias( "Wikimedia\\IDLeDOM\\DOMParser", "Wikimedia\\Parsoid\\DOM\\DOMParser" );
class_alias( "Wikimedia\\IDLeDOM\\Element", "Wikimedia\\Parsoid\\DOM\\Element" );
class_alias( "Wikimedia\\IDLeDOM\\Node", "Wikimedia\\Parsoid\\DOM\\Node" );
class_alias( "Wikimedia\\IDLeDOM\\NodeList", "Wikimedia\\Parsoid\\DOM\\NodeList" );
class_alias( "Wikimedia\\IDLeDOM\\ProcessingInstruction", "Wikimedia\\Parsoid\\DOM\\ProcessingInstruction" );
class_alias( "Wikimedia\\IDLeDOM\\Text", "Wikimedia\\Parsoid\\DOM\\Text" );
