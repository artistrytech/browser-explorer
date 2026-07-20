import { useToast } from '../stores/toast';
import styles from './ToastHost.module.scss';
import { createCssModuleClassNames } from '../lib/cssModule';

const cx = createCssModuleClassNames(styles);

export function ToastHost() {
  const { toasts, dismiss } = useToast();
  if (toasts.length === 0) return null;
  return (
    <div className={cx("toast-host")}>
      {toasts.map((t) => (
        <div key={t.id} className={cx(`toast ${t.kind}`)} onClick={() => dismiss(t.id)}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
