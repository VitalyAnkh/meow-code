import * as vscode from 'vscode'

import { commands, Mode }      from './commands/index'
import { HistoryManager }      from './history'
import { Register, Registers } from './registers'
import { SavedSelection }      from './utils/savedSelection'


/** Name of the extension, used in commands and settings. */
export const extensionName = 'dance'

type CursorStyle = 'line' | 'block' | 'underline' | 'line-thin' | 'block-outline' | 'underline-thin' | 'inherit'
type LineNumbers = 'on' | 'off' | 'relative' | 'inherit'

/** Mode-specific configuration. */
class ModeConfiguration {
  private constructor(
    readonly mode: Mode,
    readonly modePrefix: string,

    public lineNumbers: vscode.TextEditorLineNumbersStyle,
    public cursorStyle: vscode.TextEditorCursorStyle,
    public decorationType?: vscode.TextEditorDecorationType,
  ) {}

  static insert() {
    return new ModeConfiguration(
      Mode.Insert,
      'insertMode',

      vscode.TextEditorLineNumbersStyle.On,
      vscode.TextEditorCursorStyle.Line,
    )
  }

  static normal() {
    return new ModeConfiguration(
      Mode.Normal,
      'normalMode',

      vscode.TextEditorLineNumbersStyle.Relative,
      vscode.TextEditorCursorStyle.Line,
    )
  }

  observeLineHighlightPreference(extension: Extension, defaultValue: string | null) {
    extension.observePreference<string | null>(this.modePrefix + '.lineHighlight', defaultValue, value => {
      extension.updateDecorations(this, value)
    }, true)
  }

  observeLineNumbersPreference(extension: Extension, defaultValue: LineNumbers) {
    extension.observePreference<LineNumbers>(this.modePrefix + '.lineNumbers', defaultValue, value => {
      this.lineNumbers = this.lineNumbersStringToLineNumbersStyle(value)
    }, true)
  }

  updateLineNumbers(extension: Extension, defaultValue: LineNumbers) {
    this.lineNumbers = this.lineNumbersStringToLineNumbersStyle(
      extension.configuration.get(this.modePrefix + '.lineNumbers') ?? defaultValue,
    )
  }

  observeCursorStylePreference(extension: Extension, defaultValue: CursorStyle) {
    extension.observePreference<CursorStyle>(this.modePrefix + '.cursorStyle', defaultValue, value => {
      this.cursorStyle = this.cursorStyleStringToCursorStyle(value)
    }, true)
  }

  updateCursorStyle(extension: Extension, defaultValue: CursorStyle) {
    this.cursorStyle = this.cursorStyleStringToCursorStyle(
      extension.configuration.get(this.modePrefix + '.cursorStyle') ?? defaultValue,
    )
  }

  private lineNumbersStringToLineNumbersStyle(lineNumbers: LineNumbers) {
    switch (lineNumbers) {
      case 'on':
        return vscode.TextEditorLineNumbersStyle.On
      case 'off':
        return vscode.TextEditorLineNumbersStyle.Off
      case 'relative':
        return vscode.TextEditorLineNumbersStyle.Relative
      case 'inherit':
      default:
        const vscodeLineNumbers = vscode.workspace.getConfiguration().get<LineNumbers | 'interval'>('editor.lineNumbers', 'on')

        switch (vscodeLineNumbers) {
          case 'on':
            return vscode.TextEditorLineNumbersStyle.On
          case 'off':
            return vscode.TextEditorLineNumbersStyle.Off
          case 'relative':
            return vscode.TextEditorLineNumbersStyle.Relative
          case 'interval': // This is a real option but its not in vscode.d.ts
            return 3
          default:
            return vscode.TextEditorLineNumbersStyle.On
        }
    }
  }

  private cursorStyleStringToCursorStyle(cursorStyle: CursorStyle) {
    switch (cursorStyle) {
      case 'block':
        return vscode.TextEditorCursorStyle.Block
      case 'block-outline':
        return vscode.TextEditorCursorStyle.BlockOutline
      case 'line':
        return vscode.TextEditorCursorStyle.Line
      case 'line-thin':
        return vscode.TextEditorCursorStyle.LineThin
      case 'underline':
        return vscode.TextEditorCursorStyle.Underline
      case 'underline-thin':
        return vscode.TextEditorCursorStyle.UnderlineThin

      case 'inherit':
      default:
        const vscodeCursorStyle = vscode.workspace.getConfiguration().get<CursorStyle>('editor.cursorStyle', 'line')

        switch (vscodeCursorStyle) {
          case 'block':
            return vscode.TextEditorCursorStyle.Block
          case 'block-outline':
            return vscode.TextEditorCursorStyle.BlockOutline
          case 'line':
            return vscode.TextEditorCursorStyle.Line
          case 'line-thin':
            return vscode.TextEditorCursorStyle.LineThin
          case 'underline':
            return vscode.TextEditorCursorStyle.Underline
          case 'underline-thin':
            return vscode.TextEditorCursorStyle.UnderlineThin
          default:
            return vscode.TextEditorCursorStyle.Line
        }
    }
  }
}

const blankCharacters =
  '\r\n\t ' + String.fromCharCode(0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000)

/**
 * A character set.
 */
export const enum CharSet {
  /** Whether the set should be inverted when checking for existence. */
  Invert      = 0b001,
  /** Blank characters (whitespace), such as ' \t\n'. */
  Blank       = 0b010,
  /** Punctuation characters, such as '.,;'. */
  Punctuation = 0b100,

  /** Word character (neither blank nor punctuation). */
  Word = Invert | Blank | Punctuation,
  /** Non-blank character (either word or punctuation). */
  NonBlank = Invert | Blank,
}

/**
 * Global state of the extension.
 */
export class Extension implements vscode.Disposable {
  private readonly configurationChangeHandlers = new Map<string, () => void>()
  configuration = vscode.workspace.getConfiguration(extensionName)

  enabled: boolean = false

  allowEmptySelections: boolean = true

  typeCommand: vscode.Disposable | undefined = undefined
  changeEditorCommand: vscode.Disposable | undefined = undefined

  currentCount: number = 0
  currentRegister: Register | undefined = undefined

  ignoreSelectionChanges = false

  readonly subscriptions: vscode.Disposable[] = []
  readonly statusBarItem: vscode.StatusBarItem

  readonly modeMap = new WeakMap<vscode.TextDocument, Mode>()
  readonly savedSelections = new WeakMap<vscode.TextDocument, SavedSelection[]>()

  readonly registers = new Registers()
  readonly history   = new HistoryManager()

  readonly insertMode = ModeConfiguration.insert()
  readonly normalMode = ModeConfiguration.normal()

  private normalizeTimeoutToken: NodeJS.Timeout | undefined = undefined
  cancellationTokenSource?: vscode.CancellationTokenSource

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(undefined, 100)
    this.statusBarItem.tooltip = 'Current mode'

    // This needs to be before setEnabled for normalizing selections on start.
    this.observePreference<boolean>('selections.allowEmpty', true, value => {
      this.allowEmptySelections = value
    }, true)

    // Configuration: line highlight.
    this.insertMode.observeLineHighlightPreference(this, null)
    this.normalMode.observeLineHighlightPreference(this, 'editor.hoverHighlightBackground')

    // Configuration: line numbering.
    this.insertMode.observeLineNumbersPreference(this, 'inherit')
    this.normalMode.observeLineNumbersPreference(this, 'relative')

    this.configurationChangeHandlers.set('editor.lineNumbers', () => {
      this.insertMode.updateLineNumbers(this, 'inherit')
      this.normalMode.updateLineNumbers(this, 'relative')
    })

    // Configuration: cursor style.
    this.insertMode.observeCursorStylePreference(this, 'inherit')
    this.normalMode.observeCursorStylePreference(this, 'inherit')

    this.configurationChangeHandlers.set('editor.cursorStyle', () => {
      this.insertMode.updateCursorStyle(this, 'inherit')
      this.normalMode.updateCursorStyle(this, 'inherit')
    })

    // Lastly, enable the extension and set up modes.
    this.setEnabled(this.configuration.get('enabled', true), false)
  }

  updateDecorations(mode: ModeConfiguration, color: string | null) {
    if (mode.decorationType !== undefined)
      mode.decorationType.dispose()

    if (color === null || color.length === 0)
      return mode.decorationType = undefined

    mode.decorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: color[0] === '#' ? color : new vscode.ThemeColor(color),
      isWholeLine: true,
    })

    if (this.getMode() === mode.mode && vscode.window.activeTextEditor !== undefined)
      this.setDecorations(vscode.window.activeTextEditor, mode.decorationType)

    return
  }

  setEditorMode(editor: vscode.TextEditor, mode: Mode) {
    if (this.modeMap.get(editor.document) === mode)
      return Promise.resolve()

    this.modeMap.set(editor.document, mode)

    if (mode === Mode.Insert) {
      this.clearDecorations(editor, this.normalMode.decorationType)
      this.setDecorations(editor, this.insertMode.decorationType)

      editor.options.lineNumbers = this.insertMode.lineNumbers
      editor.options.cursorStyle = this.insertMode.cursorStyle
    } else {
      if (mode === Mode.Awaiting) {
        this.typeCommand?.dispose()
        this.typeCommand = undefined
      }

      this.clearDecorations(editor, this.insertMode.decorationType)
      this.setDecorations(editor, this.normalMode.decorationType)

      editor.options.lineNumbers = this.normalMode.lineNumbers
      editor.options.cursorStyle = this.normalMode.cursorStyle

      this.normalizeSelections(editor)
    }

    if (vscode.window.activeTextEditor === editor)
      return this.onActiveModeChanged(mode)

    return Promise.resolve()
  }

  getMode() {
    const editor = vscode.window.activeTextEditor

    return editor === undefined
      ? Mode.Disabled
      : this.modeMap.get(editor.document) || Mode.Normal
  }

  setMode(mode: Mode) {
    const editor = vscode.window.activeTextEditor

    return editor === undefined
      ? Promise.resolve()
      : this.setEditorMode(editor, mode)
  }

  private async onActiveModeChanged(mode: Mode) {
    if (mode === Mode.Insert) {
      this.statusBarItem.text = '$(pencil) INSERT'
    } else if (mode === Mode.Normal) {
      this.statusBarItem.text = '$(beaker) NORMAL'
    }

    await vscode.commands.executeCommand('setContext', extensionName + '.mode', mode)
  }

  private clearDecorations(editor: vscode.TextEditor, decorationType: vscode.TextEditorDecorationType | undefined) {
    if (decorationType !== undefined)
      editor.setDecorations(decorationType, [])
  }

  private setDecorations(editor: vscode.TextEditor, decorationType: vscode.TextEditorDecorationType | undefined) {
    if (decorationType === undefined)
      return

    const selection = editor.selection

    if (selection.end.character === 0 && selection.end.line > 0 && !this.allowEmptySelections) {
      editor.setDecorations(decorationType, [new vscode.Range(selection.start, selection.end.with(selection.end.line - 1, 0))])
      editor.options.cursorStyle = vscode.TextEditorCursorStyle.LineThin
    } else {
      editor.setDecorations(decorationType, [selection])
      editor.options.cursorStyle = this.modeMap.get(editor.document) === Mode.Insert ? this.insertMode.cursorStyle : this.normalMode.cursorStyle
    }
  }

  setEnabled(enabled: boolean, changeConfiguration: boolean) {
    if (enabled === this.enabled)
      return

    this.subscriptions.splice(0).forEach(x => x.dispose())

    if (!enabled) {
      const restoreLineNumbering = (visibleEditors: vscode.TextEditor[]) => {
        for (const editor of visibleEditors) {
          if (!this.modeMap.delete(editor.document))
            continue

          const lineNumbering = vscode.workspace.getConfiguration('editor').get('lineNumbers')

          editor.options.lineNumbers = lineNumbering === 'on'       ? vscode.TextEditorLineNumbersStyle.On
                                     : lineNumbering === 'relative' ? vscode.TextEditorLineNumbersStyle.Relative
                                     : lineNumbering === 'interval' ? vscode.TextEditorLineNumbersStyle.Relative + 1
                                     :                                vscode.TextEditorLineNumbersStyle.Off

          this.clearDecorations(editor, this.normalMode.decorationType)
          this.clearDecorations(editor, this.insertMode.decorationType)
        }
      }

      this.statusBarItem.hide()

      this.setMode(Mode.Disabled)
      this.changeEditorCommand!.dispose()

      this.subscriptions.push(
        vscode.window.onDidChangeVisibleTextEditors(restoreLineNumbering),
      )

      restoreLineNumbering(vscode.window.visibleTextEditors)

      if (changeConfiguration)
        vscode.workspace.getConfiguration(extensionName).update('enabled', false)
    } else {
      this.statusBarItem.show()

      this.setMode(Mode.Normal)
      this.changeEditorCommand = vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor === undefined)
          return

        let mode = this.modeMap.get(editor.document)

        if (mode === undefined)
          return this.setEditorMode(editor, mode = Mode.Normal)
        else
          return this.onActiveModeChanged(mode)
      })

      this.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(e => {
          this.cancellationTokenSource?.dispose()

          const mode = this.modeMap.get(e.textEditor.document)

          if (mode === Mode.Awaiting) {
            this.setEditorMode(e.textEditor, Mode.Normal)
          }

          if (mode === Mode.Insert)
            this.setDecorations(e.textEditor, this.insertMode.decorationType)
          else
            this.setDecorations(e.textEditor, this.normalMode.decorationType)

          if (this.normalizeTimeoutToken !== undefined) {
            clearTimeout(this.normalizeTimeoutToken)
            this.normalizeTimeoutToken = undefined
          }

          if (e.kind === vscode.TextEditorSelectionChangeKind.Mouse) {
            this.normalizeTimeoutToken = setTimeout(() => {
              this.normalizeSelections(e.textEditor)
              this.normalizeTimeoutToken = undefined
            }, 200)
          } else {
            this.normalizeSelections(e.textEditor)
          }
        }),

        vscode.workspace.onDidChangeTextDocument(e => {
          const savedSelections = this.savedSelections.get(e.document)

          if (savedSelections !== undefined) {
            for (let i = 0; i < savedSelections.length; i++) {
              const savedSelection = savedSelections[i]

              for (let j = 0; j < e.contentChanges.length; j++)
                savedSelection.updateAfterDocumentChanged(e.contentChanges[j])
            }
          }
        }),

        vscode.workspace.onDidChangeConfiguration(e => {
          this.configuration = vscode.workspace.getConfiguration(extensionName)

          for (const [section, handler] of this.configurationChangeHandlers.entries()) {
            if (e.affectsConfiguration(section))
              handler()
          }
        }),
      )

      for (let i = 0; i < commands.length; i++)
        this.subscriptions.push(commands[i].register(this))

      if (changeConfiguration)
        vscode.workspace.getConfiguration(extensionName).update('enabled', true)
    }

    return this.enabled = enabled
  }

  /**
   * Make all selections in the editor non-empty by selecting at least one character.
   */
  normalizeSelections(editor: vscode.TextEditor) {
    if (this.allowEmptySelections || this.ignoreSelectionChanges)
      return

    if (this.modeMap.get(editor.document) !== Mode.Normal)
      return

    // Since this is called every time when selection changes, avoid allocations
    // unless really needed and iterate manually without using helper functions.
    let normalizedSelections: vscode.Selection[] | undefined = undefined

    for (let i = 0; i < editor.selections.length; i++) {
      const selection = editor.selections[i]
      const isReversedOneCharacterSelection = selection.isSingleLine
        ? (selection.anchor.character === selection.active.character + 1)
        : (selection.anchor.character === 0 && selection.anchor.line === selection.active.line + 1 && editor.document.lineAt(selection.active).text.length === selection.active.character)

      if (isReversedOneCharacterSelection) {
        if (normalizedSelections === undefined) {
          // Change needed. Allocate the new array and copy what we have so far.
          normalizedSelections = editor.selections.slice(0, i)
        }

        normalizedSelections.push(new vscode.Selection(selection.active, selection.anchor))
      } else if (selection.isEmpty) {
        if (normalizedSelections === undefined) {
          // Change needed. Allocate the new array and copy what we have so far.
          normalizedSelections = editor.selections.slice(0, i)
        }

        const active = selection.active

        if (active.character >= editor.document.lineAt(active.line).range.end.character) {
          // Selection is at line end. Select line break.
          if (active.line === editor.document.lineCount - 1) {
            // Selection is at the very end of the document as well. Select the last character instead.
            if (active.character === 0) {
              if (active.line === 0) {
                // There is no character in this document, so we give up on normalizing.
                continue
              } else {
                normalizedSelections.push(new vscode.Selection(new vscode.Position(active.line - 1, Number.MAX_SAFE_INTEGER), active))
              }
            } else {
              normalizedSelections.push(new vscode.Selection(active.translate(0, -1), active))
            }
          } else {
            normalizedSelections.push(new vscode.Selection(active, new vscode.Position(active.line + 1, 0)))
          }
        } else {
          const offset = editor.document.offsetAt(selection.active)
          const nextPos = editor.document.positionAt(offset + 1)

          if (nextPos.isAfter(selection.active)) {
            // Move anchor to select 1 character after, but keep the cursor position.
            normalizedSelections.push(new vscode.Selection(active.translate(0, 1), active))
          } else {
            // Selection is at the very end of the document. Select the last character instead.
            normalizedSelections.push(new vscode.Selection(active.translate(0, -1), active))
          }
        }
      } else if (normalizedSelections !== undefined) {
        normalizedSelections.push(selection)
      }
    }

    if (normalizedSelections !== undefined)
      editor.selections = normalizedSelections
  }

  dispose() {
    this.history.dispose()
    this.statusBarItem.dispose()

    if (!this.enabled)
      return

    this.typeCommand!.dispose()
  }

  /**
   * Listen for changes to the specified preference and calls the given handler when a change occurs.
   *
   * Must be called in the constructor.
   *
   * @param triggerNow If `true`, the handler will also be triggered immediately with the current value.
   */
  observePreference<T>(section: string, defaultValue: T, handler: (value: T) => void, triggerNow = false) {
    this.configurationChangeHandlers.set('dance.' + section, () => {
      handler(this.configuration.get(section, defaultValue))
    })

    if (triggerNow) {
      handler(this.configuration.get(section, defaultValue))
    }
  }

  /**
   * Returns a string containing all the characters belonging to the given charset.
   */
  getCharacters(charSet: CharSet, document: vscode.TextDocument) {
    let characters = ''

    if (charSet & CharSet.Blank) {
      characters += blankCharacters
    }

    if (charSet & CharSet.Punctuation) {
      const wordSeparators = vscode.workspace.getConfiguration('editor', { languageId: document.languageId }).get('wordSeparators')

      if (typeof wordSeparators === 'string')
        characters += wordSeparators
    }

    return characters
  }

  /**
   * Returns an array containing all the characters belonging to the given charset.
   */
  getCharCodes(charSet: CharSet, document: vscode.TextDocument) {
    const characters = this.getCharacters(charSet, document),
          charCodes = new Uint32Array(characters.length)

    for (let i = 0; i < characters.length; i++) {
      charCodes[i] = characters.charCodeAt(i)
    }

    return charCodes
  }

  /**
   * Returns a function that tests whether a character belongs to the given charset.
   */
  getCharSetFunction(charSet: CharSet, document: vscode.TextDocument) {
    const charCodes = this.getCharCodes(charSet, document)

    if (charSet & CharSet.Invert) {
      return function(this: Uint32Array, charCode: number) {
        return this.indexOf(charCode) === -1
      }.bind(charCodes)
    } else {
      return function(this: Uint32Array, charCode: number) {
        return this.indexOf(charCode) !== -1
      }.bind(charCodes)
    }
  }

  /**
   * Saves the given selection, tracking changes to the given document and updating
   * the selection correspondingly over time.
   */
  saveSelection(document: vscode.TextDocument, selection: vscode.Selection) {
    const savedSelection = new SavedSelection(document, selection),
          savedSelections = this.savedSelections.get(document)

    if (savedSelections === undefined)
      this.savedSelections.set(document, [savedSelection])
    else
      savedSelections.push(savedSelection)

    return savedSelection
  }

  /**
   * Forgets the given saved selections.
   */
  forgetSelections(document: vscode.TextDocument, selections: readonly SavedSelection[]) {
    const savedSelections = this.savedSelections.get(document)

    if (savedSelections !== undefined) {
      for (let i = 0; i < selections.length; i++) {
        const index = savedSelections.indexOf(selections[i])

        if (index !== -1)
          savedSelections.splice(index, 1)
      }
    }
  }
}

export let state: Extension

export function activate(context: vscode.ExtensionContext) {
  state = new Extension()

  context.subscriptions.push(
    vscode.commands.registerCommand(extensionName + '.toggle', () => state.setEnabled(!state.enabled, false)),
  )

  if (process.env.VERBOSE_LOGGING === 'true') {
    // Log all commands we need to implement
    Promise.all([vscode.commands.getCommands(true), import('../commands/index')])
      .then(([registeredCommands, { commands }]) => {
        for (const command of Object.values(commands)) {
          if (registeredCommands.indexOf(command.id) === -1)
            console.warn('Command', command.id, 'is defined but not implemented.')
        }
      })
  }
}

export function deactivate() {
  state.dispose()
}
