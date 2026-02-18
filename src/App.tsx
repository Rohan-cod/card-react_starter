import { useEffect, useRef, useState } from 'react';
import {
  CardFsFileType,
  CardSdk,
  getKeyFromBlob,
  type CardEventHandler,
  type CardInitData,
  type CardInitErrorPayload,
  type CardKeyBlobV1,
  type CardUser,
} from 'dome-embedded-app-sdk';

import './App.css';

type Operator = '+' | '-' | '*' | '/';

type CalcHistoryEntry = {
  id: string;
  expression: string;
  result: string;
  timestamp: number;
};

const HISTORY_FILE_NAME = 'calculator-history.json';
const MAX_HISTORY_ITEMS = 50;

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function toDisplayValue(value: number): string {
  if (!Number.isFinite(value)) {
    return 'Error';
  }
  return Number.isInteger(value) ? value.toString() : value.toFixed(8).replace(/\.?0+$/, '');
}

function parseHistoryData(data: unknown): CalcHistoryEntry[] {
  const source = Array.isArray(data)
    ? data
    : typeof data === 'object' && data !== null && Array.isArray((data as { history?: unknown }).history)
      ? ((data as { history: unknown[] }).history ?? [])
      : [];

  return source
    .filter((entry) => typeof entry === 'object' && entry !== null)
    .map((entry) => {
      const typed = entry as Partial<CalcHistoryEntry>;
      return {
        id: typeof typed.id === 'string' ? typed.id : `${Date.now()}-${Math.random()}`,
        expression: typeof typed.expression === 'string' ? typed.expression : '',
        result: typeof typed.result === 'string' ? typed.result : '',
        timestamp: typeof typed.timestamp === 'number' ? typed.timestamp : Date.now(),
      };
    })
    .filter((entry) => entry.expression && entry.result)
    .slice(0, MAX_HISTORY_ITEMS);
}

function App() {
  const [user, setUser] = useState<CardUser | null>(null);
  const [sdk, setSdk] = useState<CardSdk | null>(null);
  const [initError, setInitError] = useState<CardInitErrorPayload | null>(null);
  const [isInitReceived, setIsInitReceived] = useState(false);
  const hasLoadedHistoryRef = useRef(false);

  const [currentInput, setCurrentInput] = useState('0');
  const [storedValue, setStoredValue] = useState<number | null>(null);
  const [pendingOperator, setPendingOperator] = useState<Operator | null>(null);
  const [resetInputOnNextDigit, setResetInputOnNextDigit] = useState(false);

  const [history, setHistory] = useState<CalcHistoryEntry[]>([]);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);

  const loadHistory = (activeSdk: CardSdk) => {
    if (!activeSdk.canRead()) {
      setHistoryNotice('Read permission is not available for history.');
      return;
    }

    activeSdk.cardFS.read(HISTORY_FILE_NAME, {
      next: ({ data, is_complete, is_stale }) => {
        if (data !== undefined) {
          setHistory(parseHistoryData(data));
        }

        if (is_complete && is_stale) {
          setHistoryNotice('Showing cached history while offline.');
        } else if (is_complete) {
          setHistoryNotice(null);
        }
      },
      error: (error) => {
        if (error?.code === 'NOT_FOUND') {
          setHistory([]);
          setHistoryNotice(null);
          return;
        }

        setHistoryNotice(error?.message ?? 'Unable to load history.');
      },
    });
  };

  useEffect(() => {
    const decBlob = import.meta.env.VITE_CARD_DEC_BLOB;
    if (!decBlob) {
      setInitError({ message: 'Missing VITE_CARD_DEC_BLOB env variable', error_code: 'MISSING_CARD_DEC_BLOB' });
      return;
    }

    let reactStarterDecBlob: CardKeyBlobV1;
    try {
      reactStarterDecBlob = JSON.parse(decBlob) as CardKeyBlobV1;
    } catch (_err) {
      setInitError({ message: 'Invalid VITE_CARD_DEC_BLOB JSON', error_code: 'INVALID_CARD_DEC_BLOB' });
      return;
    }

    const eventHandler: CardEventHandler = {
      onInit: (data: CardInitData) => {
        const { user: initUser, ui } = data;
        if (initUser) {
          setUser(initUser);
        }

        const theme = ui?.theme === 'dark' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', theme);
        setIsInitReceived(true);
      },
      onInitError: (data: CardInitErrorPayload) => {
        setInitError(data);
      },
      onError: (data) => {
        console.error('Some Error', `${data.message} (${data.error_code})`);
      },
    };

    CardSdk.init(getKeyFromBlob(reactStarterDecBlob), eventHandler)
      .then((initializedSdk) => {
        setSdk(initializedSdk);
      })
      .catch((err) => {
        console.error('Init failed', err);
      });
  }, []);

  useEffect(() => {
    if (!sdk || !isInitReceived || hasLoadedHistoryRef.current) {
      return;
    }

    hasLoadedHistoryRef.current = true;
    loadHistory(sdk);
  }, [sdk, isInitReceived]);

  const persistHistory = async (entries: CalcHistoryEntry[]) => {
    if (!sdk || !sdk.canWrite()) {
      setHistoryNotice('Write permission is not available, so history is view-only.');
      return;
    }

    try {
      await sdk.cardFS.write(HISTORY_FILE_NAME, entries, CardFsFileType.JSON);
      setHistoryNotice(null);
    } catch (error) {
      console.error('Failed to persist history', error);
      setHistoryNotice('Failed to save history.');
    }
  };

  const applyOperation = (left: number, right: number, operator: Operator): number => {
    switch (operator) {
      case '+':
        return left + right;
      case '-':
        return left - right;
      case '*':
        return left * right;
      case '/':
        return right === 0 ? Number.NaN : left / right;
      default:
        return right;
    }
  };

  const updateHistory = (entry: CalcHistoryEntry) => {
    setHistory((prev) => {
      const next = [entry, ...prev].slice(0, MAX_HISTORY_ITEMS);
      void persistHistory(next);
      return next;
    });
  };

  const clearCalculator = () => {
    setCurrentInput('0');
    setStoredValue(null);
    setPendingOperator(null);
    setResetInputOnNextDigit(false);
  };

  const inputDigit = (digit: string) => {
    setCurrentInput((prev) => {
      if (resetInputOnNextDigit) {
        setResetInputOnNextDigit(false);
        return digit;
      }

      if (prev === '0') {
        return digit;
      }

      if (prev.length >= 16) {
        return prev;
      }

      return `${prev}${digit}`;
    });
  };

  const inputDecimal = () => {
    setCurrentInput((prev) => {
      if (resetInputOnNextDigit) {
        setResetInputOnNextDigit(false);
        return '0.';
      }
      if (prev.includes('.')) {
        return prev;
      }
      return `${prev}.`;
    });
  };

  const deleteLast = () => {
    if (resetInputOnNextDigit) {
      return;
    }
    setCurrentInput((prev) => (prev.length <= 1 ? '0' : prev.slice(0, -1)));
  };

  const chooseOperator = (operator: Operator) => {
    const currentValue = Number.parseFloat(currentInput);
    if (Number.isNaN(currentValue)) {
      return;
    }

    if (storedValue !== null && pendingOperator && !resetInputOnNextDigit) {
      const computed = applyOperation(storedValue, currentValue, pendingOperator);
      setCurrentInput(toDisplayValue(computed));
      setStoredValue(computed);
    } else {
      setStoredValue(currentValue);
    }

    setPendingOperator(operator);
    setResetInputOnNextDigit(true);
  };

  const evaluate = () => {
    if (!pendingOperator || storedValue === null) {
      return;
    }

    const rightValue = Number.parseFloat(currentInput);
    const leftValue = storedValue;
    const result = applyOperation(leftValue, rightValue, pendingOperator);
    const resultDisplay = toDisplayValue(result);
    const entry: CalcHistoryEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      expression: `${toDisplayValue(leftValue)} ${pendingOperator} ${toDisplayValue(rightValue)}`,
      result: resultDisplay,
      timestamp: Date.now(),
    };

    setCurrentInput(resultDisplay);
    setStoredValue(null);
    setPendingOperator(null);
    setResetInputOnNextDigit(true);
    updateHistory(entry);
  };

  if (initError) {
    return (
      <div className="main">
        <h3>Initialization Failed</h3>
        <p>
          {initError.message} ({initError.error_code})
        </p>
      </div>
    );
  }

  if (!sdk || !user) {
    return <div className="main">Loading...</div>;
  }

  return (
    <div className="main">
      <button className="history-toggle" type="button" onClick={() => setIsHistoryOpen((prev) => !prev)}>
        History
      </button>

      <aside className={`history-panel ${isHistoryOpen ? 'open' : ''}`}>
        <div className="history-head">
          <h2>History</h2>
          <button className="history-close" type="button" onClick={() => setIsHistoryOpen(false)}>
            Close
          </button>
        </div>
        {historyNotice ? <p className="notice">{historyNotice}</p> : null}
        {history.length === 0 ? <p className="notice">No calculations yet.</p> : null}
        <ul className="history-list">
          {history.map((item) => (
            <li key={item.id}>
              <div className="history-expression">
                {item.expression} = <strong>{item.result}</strong>
              </div>
              <div className="history-time">{formatTime(item.timestamp)}</div>
            </li>
          ))}
        </ul>
      </aside>

      <section className="calculator">
        <div className="calculator-head">
          <p className="welcome">Hi, {user.getFullName?.() ?? 'there'}</p>
        </div>

        <div className="display">{currentInput}</div>

        <div className="keypad">
          <button type="button" onClick={clearCalculator}>
            C
          </button>
          <button type="button" onClick={deleteLast}>
            DEL
          </button>
          <button type="button" onClick={() => chooseOperator('/')}>
            /
          </button>
          <button type="button" onClick={() => chooseOperator('*')}>
            *
          </button>

          <button type="button" onClick={() => inputDigit('7')}>
            7
          </button>
          <button type="button" onClick={() => inputDigit('8')}>
            8
          </button>
          <button type="button" onClick={() => inputDigit('9')}>
            9
          </button>
          <button type="button" onClick={() => chooseOperator('-')}>
            -
          </button>

          <button type="button" onClick={() => inputDigit('4')}>
            4
          </button>
          <button type="button" onClick={() => inputDigit('5')}>
            5
          </button>
          <button type="button" onClick={() => inputDigit('6')}>
            6
          </button>
          <button type="button" onClick={() => chooseOperator('+')}>
            +
          </button>

          <button type="button" onClick={() => inputDigit('1')}>
            1
          </button>
          <button type="button" onClick={() => inputDigit('2')}>
            2
          </button>
          <button type="button" onClick={() => inputDigit('3')}>
            3
          </button>
          <button type="button" className="equals" onClick={evaluate}>
            =
          </button>

          <button type="button" className="zero" onClick={() => inputDigit('0')}>
            0
          </button>
          <button type="button" onClick={inputDecimal}>
            .
          </button>
        </div>
      </section>
    </div>
  );
}

export default App;
