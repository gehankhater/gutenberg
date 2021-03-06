/**
 * External dependencies
 */
import { connect } from 'react-redux';
import classnames from 'classnames';
import { get, reduce, size, castArray, noop, first, last } from 'lodash';
import tinymce from 'tinymce';

/**
 * WordPress dependencies
 */
import { Component, findDOMNode, compose } from '@wordpress/element';
import {
	keycodes,
	focus,
	isTextField,
	placeCaretAtHorizontalEdge,
	placeCaretAtVerticalEdge,
} from '@wordpress/utils';
import {
	BlockEdit,
	createBlock,
	cloneBlock,
	getBlockType,
	getSaveElement,
	isReusableBlock,
	isUnmodifiedDefaultBlock,
} from '@wordpress/blocks';
import { withFilters, withContext, withAPIData } from '@wordpress/components';
import { __, sprintf } from '@wordpress/i18n';

/**
 * Internal dependencies
 */
import BlockMover from '../block-mover';
import BlockDropZone from '../block-drop-zone';
import BlockSettingsMenu from '../block-settings-menu';
import InvalidBlockWarning from './invalid-block-warning';
import BlockCrashWarning from './block-crash-warning';
import BlockCrashBoundary from './block-crash-boundary';
import BlockHtml from './block-html';
import BlockContextualToolbar from './block-contextual-toolbar';
import BlockMultiControls from './multi-controls';
import BlockMobileToolbar from './block-mobile-toolbar';
import BlockInsertionPoint from './insertion-point';
import IgnoreNestedEvents from './ignore-nested-events';
import InserterWithShortcuts from '../inserter-with-shortcuts';
import { createInnerBlockList } from './utils';
import {
	editPost,
	insertBlocks,
	mergeBlocks,
	removeBlock,
	replaceBlocks,
	selectBlock,
	updateBlockAttributes,
	toggleSelection,
} from '../../store/actions';
import {
	getBlock,
	isMultiSelecting,
	getBlockIndex,
	getEditedPostAttribute,
	getNextBlockUid,
	getPreviousBlockUid,
	isBlockMultiSelected,
	isBlockSelected,
	isFirstMultiSelectedBlock,
	isSelectionEnabled,
	isTyping,
	getBlockMode,
	getCurrentPostType,
	getSelectedBlocksInitialCaretPosition,
} from '../../store/selectors';

const { BACKSPACE, DELETE, ENTER } = keycodes;

export class BlockListBlock extends Component {
	constructor() {
		super( ...arguments );

		this.setBlockListRef = this.setBlockListRef.bind( this );
		this.bindBlockNode = this.bindBlockNode.bind( this );
		this.setAttributes = this.setAttributes.bind( this );
		this.maybeHover = this.maybeHover.bind( this );
		this.hideHoverEffects = this.hideHoverEffects.bind( this );
		this.mergeBlocks = this.mergeBlocks.bind( this );
		this.onFocus = this.onFocus.bind( this );
		this.preventDrag = this.preventDrag.bind( this );
		this.onPointerDown = this.onPointerDown.bind( this );
		this.deleteOrInsertAfterWrapper = this.deleteOrInsertAfterWrapper.bind( this );
		this.onBlockError = this.onBlockError.bind( this );
		this.insertBlocksAfter = this.insertBlocksAfter.bind( this );
		this.onTouchStart = this.onTouchStart.bind( this );
		this.onClick = this.onClick.bind( this );
		this.selectOnOpen = this.selectOnOpen.bind( this );
		this.hadTouchStart = false;

		this.state = {
			error: null,
			isHovered: false,
		};
	}

	getChildContext() {
		const {
			uid,
			renderBlockMenu,
			showContextualToolbar,
		} = this.props;

		return {
			BlockList: createInnerBlockList(
				uid,
				renderBlockMenu,
				showContextualToolbar
			),
			canUserUseUnfilteredHTML: get( this.props.user, [ 'data', 'capabilities', 'unfiltered_html' ], false ),
		};
	}

	componentDidMount() {
		if ( this.props.isSelected ) {
			this.focusTabbable();
		}
	}

	componentWillReceiveProps( newProps ) {
		if ( newProps.isTypingWithinBlock || newProps.isSelected ) {
			this.hideHoverEffects();
		}
	}

	componentDidUpdate( prevProps ) {
		if ( this.props.isSelected && ! prevProps.isSelected ) {
			this.focusTabbable();
		}
	}

	setBlockListRef( node ) {
		// Disable reason: The root return element uses a component to manage
		// event nesting, but the parent block list layout needs the raw DOM
		// node to track multi-selection.
		//
		// eslint-disable-next-line react/no-find-dom-node
		node = findDOMNode( node );

		this.wrapperNode = node;

		this.props.blockRef( node, this.props.uid );
	}

	bindBlockNode( node ) {
		// Disable reason: The block element uses a component to manage event
		// nesting, but we rely on a raw DOM node for focusing.
		//
		// eslint-disable-next-line react/no-find-dom-node
		this.node = findDOMNode( node );
	}

	/**
	 * When a block becomces selected, transition focus to an inner tabbable.
	 */
	focusTabbable() {
		const { initialPosition } = this.props;

		// Focus is captured by the wrapper node, so while focus transition
		// should only consider tabbables within editable display, since it
		// may be the wrapper itself or a side control which triggered the
		// focus event, don't unnecessary transition to an inner tabbable.
		if ( this.wrapperNode.contains( document.activeElement ) ) {
			return;
		}

		// Find all tabbables within node.
		const textInputs = focus.tabbable.find( this.node ).filter( isTextField );

		// If reversed (e.g. merge via backspace), use the last in the set of
		// tabbables.
		const isReverse = -1 === initialPosition;
		const target = ( isReverse ? last : first )( textInputs );

		if ( ! target ) {
			this.wrapperNode.focus();
			return;
		}

		target.focus();

		// In reverse case, need to explicitly place caret position.
		if ( isReverse ) {
			// Special case RichText component because the placeCaret utilities
			// aren't working correctly. When merging two paragraph blocks, the
			// focus is not moved to the correct position.
			const editor = tinymce.get( target.getAttribute( 'id' ) );
			if ( editor ) {
				editor.selection.select( editor.getBody(), true );
				editor.selection.collapse( false );
			} else {
				placeCaretAtHorizontalEdge( target, true );
				placeCaretAtVerticalEdge( target, true );
			}
		}
	}

	setAttributes( attributes ) {
		const { block, onChange } = this.props;
		const type = getBlockType( block.name );
		onChange( block.uid, attributes );

		const metaAttributes = reduce( attributes, ( result, value, key ) => {
			if ( get( type, [ 'attributes', key, 'source' ] ) === 'meta' ) {
				result[ type.attributes[ key ].meta ] = value;
			}

			return result;
		}, {} );

		if ( size( metaAttributes ) ) {
			this.props.onMetaChange( {
				...this.props.meta,
				...metaAttributes,
			} );
		}
	}

	onTouchStart() {
		// Detect touchstart to disable hover on iOS
		this.hadTouchStart = true;
	}

	onClick() {
		// Clear touchstart detection
		// Browser will try to emulate mouse events also see https://www.html5rocks.com/en/mobile/touchandmouse/
		this.hadTouchStart = false;
	}

	/**
	 * A mouseover event handler to apply hover effect when a pointer device is
	 * placed within the bounds of the block. The mouseover event is preferred
	 * over mouseenter because it may be the case that a previous mouseenter
	 * event was blocked from being handled by a IgnoreNestedEvents component,
	 * therefore transitioning out of a nested block to the bounds of the block
	 * would otherwise not trigger a hover effect.
	 *
	 * @see https://developer.mozilla.org/en-US/docs/Web/Events/mouseenter
	 */
	maybeHover() {
		const { isMultiSelected, isSelected } = this.props;
		const { isHovered } = this.state;

		if ( isHovered || isMultiSelected || isSelected ||
				this.props.isMultiSelecting || this.hadTouchStart ) {
			return;
		}

		this.setState( { isHovered: true } );
	}

	/**
	 * Sets the block state as unhovered if currently hovering. There are cases
	 * where mouseleave may occur but the block is not hovered (multi-select),
	 * so to avoid unnecesary renders, the state is only set if hovered.
	 */
	hideHoverEffects() {
		if ( this.state.isHovered ) {
			this.setState( { isHovered: false } );
		}
	}

	mergeBlocks( forward = false ) {
		const { block, previousBlockUid, nextBlockUid, onMerge } = this.props;

		// Do nothing when it's the first block.
		if (
			( ! forward && ! previousBlockUid ) ||
			( forward && ! nextBlockUid )
		) {
			return;
		}

		if ( forward ) {
			onMerge( block.uid, nextBlockUid );
		} else {
			onMerge( previousBlockUid, block.uid );
		}
	}

	insertBlocksAfter( blocks ) {
		this.props.onInsertBlocks( blocks, this.props.order + 1 );
	}

	/**
	 * Marks the block as selected when focused and not already selected. This
	 * specifically handles the case where block does not set focus on its own
	 * (via `setFocus`), typically if there is no focusable input in the block.
	 *
	 * @return {void}
	 */
	onFocus() {
		if ( ! this.props.isSelected && ! this.props.isMultiSelected ) {
			this.props.onSelect();
		}
	}

	/**
	 * Prevents default dragging behavior within a block to allow for multi-
	 * selection to take effect unhampered.
	 *
	 * @param {DragEvent} event Drag event.
	 *
	 * @return {void}
	 */
	preventDrag( event ) {
		event.preventDefault();
	}

	/**
	 * Begins tracking cursor multi-selection when clicking down within block.
	 *
	 * @param {MouseEvent} event A mousedown event.
	 *
	 * @return {void}
	 */
	onPointerDown( event ) {
		// Not the main button.
		// https://developer.mozilla.org/en-US/docs/Web/API/MouseEvent/button
		if ( event.button !== 0 ) {
			return;
		}

		if ( event.shiftKey ) {
			if ( ! this.props.isSelected ) {
				this.props.onShiftSelection( this.props.uid );
				event.preventDefault();
			}
		} else {
			this.props.onSelectionStart( this.props.uid );

			// Allow user to escape out of a multi-selection to a singular
			// selection of a block via click. This is handled here since
			// onFocus excludes blocks involved in a multiselection, as
			// focus can be incurred by starting a multiselection (focus
			// moved to first block's multi-controls).
			if ( this.props.isMultiSelected ) {
				this.props.onSelect();
			}
		}
	}

	/**
	 * Interprets keydown event intent to remove or insert after block if key
	 * event occurs on wrapper node. This can occur when the block has no text
	 * fields of its own, particularly after initial insertion, to allow for
	 * easy deletion and continuous writing flow to add additional content.
	 *
	 * @param {KeyboardEvent} event Keydown event.
	 */
	deleteOrInsertAfterWrapper( event ) {
		const { keyCode, target } = event;

		if ( target !== this.wrapperNode || this.props.isLocked ) {
			return;
		}

		switch ( keyCode ) {
			case ENTER:
				// Insert default block after current block if enter and event
				// not already handled by descendant.
				this.props.onInsertBlocks( [
					createBlock( 'core/paragraph' ),
				], this.props.order + 1 );
				event.preventDefault();
				break;

			case BACKSPACE:
			case DELETE:
				// Remove block on backspace.
				const { uid, onRemove, previousBlockUid, onSelect } = this.props;
				onRemove( uid );

				if ( previousBlockUid ) {
					onSelect( previousBlockUid, -1 );
				}
				event.preventDefault();
				break;
		}
	}

	onBlockError( error ) {
		this.setState( { error } );
	}

	selectOnOpen( open ) {
		if ( open && ! this.props.isSelected ) {
			this.props.onSelect();
		}
	}

	render() {
		const {
			block,
			order,
			mode,
			showContextualToolbar,
			isLocked,
			isFirst,
			isLast,
			rootUID,
			layout,
			renderBlockMenu,
			isSelected,
			isMultiSelected,
			isFirstMultiSelected,
			isLastInSelection,
			isTypingWithinBlock,
		} = this.props;
		const isHovered = this.state.isHovered && ! this.props.isMultiSelecting;
		const { name: blockName, isValid } = block;
		const blockType = getBlockType( blockName );
		// translators: %s: Type of block (i.e. Text, Image etc)
		const blockLabel = sprintf( __( 'Block: %s' ), blockType.title );
		// The block as rendered in the editor is composed of general block UI
		// (mover, toolbar, wrapper) and the display of the block content.

		// If the block is selected and we're typing the block should not appear.
		// Empty paragraph blocks should always show up as unselected.
		const isEmptyDefaultBlock = isUnmodifiedDefaultBlock( block );
		const isSelectedNotTyping = isSelected && ! isTypingWithinBlock;
		const showSideInserter = ( isSelected || isHovered ) && isEmptyDefaultBlock;
		const shouldAppearSelected = ! showSideInserter && isSelectedNotTyping;
		const shouldShowMovers = shouldAppearSelected || isHovered || ( isEmptyDefaultBlock && isSelectedNotTyping );
		const shouldShowSettingsMenu = shouldShowMovers;
		const shouldShowContextualToolbar = shouldAppearSelected && isValid && showContextualToolbar;
		const shouldShowMobileToolbar = shouldAppearSelected;
		const { error } = this.state;

		// Insertion point can only be made visible when the side inserter is
		// not present, and either the block is at the extent of a selection or
		// is the last block in the top-level list rendering.
		const shouldShowInsertionPoint = (
			( ! isMultiSelected && ! isLast ) ||
			( isMultiSelected && isLastInSelection ) ||
			( isLast && ! rootUID && ! isEmptyDefaultBlock )
		);

		// Generate the wrapper class names handling the different states of the block.
		const wrapperClassName = classnames( 'editor-block-list__block', {
			'has-warning': ! isValid || !! error,
			'is-selected': shouldAppearSelected,
			'is-multi-selected': isMultiSelected,
			'is-hovered': isHovered,
			'is-reusable': isReusableBlock( blockType ),
		} );

		const { onReplace } = this.props;

		// Determine whether the block has props to apply to the wrapper.
		let wrapperProps = this.props.wrapperProps;
		if ( blockType.getEditWrapperProps ) {
			wrapperProps = {
				...wrapperProps,
				...blockType.getEditWrapperProps( block.attributes ),
			};
		}

		// Disable reasons:
		//
		//  jsx-a11y/mouse-events-have-key-events:
		//   - onMouseOver is explicitly handling hover effects
		//
		//  jsx-a11y/no-static-element-interactions:
		//   - Each block can be selected by clicking on it

		/* eslint-disable jsx-a11y/mouse-events-have-key-events, jsx-a11y/no-static-element-interactions, jsx-a11y/onclick-has-role, jsx-a11y/click-events-have-key-events */
		return (
			<IgnoreNestedEvents
				ref={ this.setBlockListRef }
				onMouseOver={ this.maybeHover }
				onMouseLeave={ this.hideHoverEffects }
				className={ wrapperClassName }
				data-type={ block.name }
				onTouchStart={ this.onTouchStart }
				onFocus={ this.onFocus }
				onClick={ this.onClick }
				onKeyDown={ this.deleteOrInsertAfterWrapper }
				tabIndex="0"
				childHandledEvents={ [
					'onDragStart',
					'onMouseDown',
				] }
				{ ...wrapperProps }
			>
				<BlockDropZone
					index={ order }
					rootUID={ rootUID }
					layout={ layout }
				/>
				{ shouldShowMovers && (
					<BlockMover
						uids={ [ block.uid ] }
						rootUID={ rootUID }
						layout={ layout }
						isFirst={ isFirst }
						isLast={ isLast }
					/>
				) }
				{ shouldShowSettingsMenu && (
					<BlockSettingsMenu
						uids={ [ block.uid ] }
						rootUID={ rootUID }
						renderBlockMenu={ renderBlockMenu }
					/>
				) }
				{ shouldShowContextualToolbar && <BlockContextualToolbar /> }
				{ isFirstMultiSelected && <BlockMultiControls rootUID={ rootUID } /> }
				<IgnoreNestedEvents
					ref={ this.bindBlockNode }
					onDragStart={ this.preventDrag }
					onMouseDown={ this.onPointerDown }
					className="editor-block-list__block-edit"
					aria-label={ blockLabel }
					data-block={ block.uid }
				>
					<BlockCrashBoundary onError={ this.onBlockError }>
						{ isValid && mode === 'visual' && (
							<BlockEdit
								name={ blockName }
								isSelected={ isSelected }
								attributes={ block.attributes }
								setAttributes={ this.setAttributes }
								insertBlocksAfter={ isLocked ? undefined : this.insertBlocksAfter }
								onReplace={ isLocked ? undefined : onReplace }
								mergeBlocks={ isLocked ? undefined : this.mergeBlocks }
								id={ block.uid }
								isSelectionEnabled={ this.props.isSelectionEnabled }
								toggleSelection={ this.props.toggleSelection }
							/>
						) }
						{ isValid && mode === 'html' && (
							<BlockHtml uid={ block.uid } />
						) }
						{ ! isValid && [
							<div key="invalid-preview">
								{ getSaveElement( blockType, block.attributes ) }
							</div>,
							<InvalidBlockWarning
								key="invalid-warning"
								block={ block }
							/>,
						] }
					</BlockCrashBoundary>
					{ shouldShowMobileToolbar && (
						<BlockMobileToolbar
							rootUID={ rootUID }
							uid={ block.uid }
							renderBlockMenu={ renderBlockMenu }
						/>
					) }
				</IgnoreNestedEvents>
				{ !! error && <BlockCrashWarning /> }
				{ shouldShowInsertionPoint && (
					<BlockInsertionPoint
						uid={ block.uid }
						rootUID={ rootUID }
						layout={ layout }
					/>
				) }
				{ showSideInserter && (
					<div className="editor-block-list__side-inserter">
						<InserterWithShortcuts uid={ block.uid } layout={ layout } onToggle={ this.selectOnOpen } />
					</div>
				) }
			</IgnoreNestedEvents>
		);
		/* eslint-enable jsx-a11y/no-static-element-interactions, jsx-a11y/onclick-has-role, jsx-a11y/click-events-have-key-events */
	}
}

const mapStateToProps = ( state, { uid, rootUID } ) => {
	const isSelected = isBlockSelected( state, uid );
	return {
		previousBlockUid: getPreviousBlockUid( state, uid ),
		nextBlockUid: getNextBlockUid( state, uid ),
		block: getBlock( state, uid ),
		isMultiSelected: isBlockMultiSelected( state, uid ),
		isFirstMultiSelected: isFirstMultiSelectedBlock( state, uid ),
		isMultiSelecting: isMultiSelecting( state ),
		isLastInSelection: state.blockSelection.end === uid,
		// We only care about this prop when the block is selected
		// Thus to avoid unnecessary rerenders we avoid updating the prop if the block is not selected.
		isTypingWithinBlock: isSelected && isTyping( state ),
		order: getBlockIndex( state, uid, rootUID ),
		meta: getEditedPostAttribute( state, 'meta' ),
		mode: getBlockMode( state, uid ),
		isSelectionEnabled: isSelectionEnabled( state ),
		postType: getCurrentPostType( state ),
		initialPosition: getSelectedBlocksInitialCaretPosition( state ),
		isSelected,
	};
};

const mapDispatchToProps = ( dispatch, ownProps ) => ( {
	onChange( uid, attributes ) {
		dispatch( updateBlockAttributes( uid, attributes ) );
	},

	onSelect( uid = ownProps.uid, initialPosition ) {
		dispatch( selectBlock( uid, initialPosition ) );
	},

	onInsertBlocks( blocks, index ) {
		const { rootUID, layout } = ownProps;

		blocks = blocks.map( ( block ) => cloneBlock( block, { layout } ) );

		dispatch( insertBlocks( blocks, index, rootUID ) );
	},

	onRemove( uid ) {
		dispatch( removeBlock( uid ) );
	},

	onMerge( ...args ) {
		dispatch( mergeBlocks( ...args ) );
	},

	onReplace( blocks ) {
		const { layout } = ownProps;

		blocks = castArray( blocks ).map( ( block ) => (
			cloneBlock( block, { layout } )
		) );

		dispatch( replaceBlocks( [ ownProps.uid ], blocks ) );
	},

	onMetaChange( meta ) {
		dispatch( editPost( { meta } ) );
	},

	toggleSelection( selectionEnabled ) {
		dispatch( toggleSelection( selectionEnabled ) );
	},
} );

BlockListBlock.childContextTypes = {
	BlockList: noop,
	canUserUseUnfilteredHTML: noop,
};

export default compose(
	connect( mapStateToProps, mapDispatchToProps ),
	withContext( 'editor' )( ( settings ) => {
		const { templateLock } = settings;

		return {
			isLocked: !! templateLock,
		};
	} ),
	withFilters( 'editor.BlockListBlock' ),
	withAPIData( ( { postType } ) => ( {
		user: `/wp/v2/users/me?post_type=${ postType }&context=edit`,
	} ) ),
)( BlockListBlock );
