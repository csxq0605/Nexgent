# order-lib

Prices a shop order. All amounts are integer cents.

- `src/catalog.js`: product prices and stock.
- `src/discount.js`: discount codes. `SAVE10` takes 10% off orders of at least 100.00; `FLAT5` takes 5.00 off orders of at least 30.00.
- `src/inventory.js`: checks that every SKU in an order is in stock, across all lines of the order.
- `src/order.js`: `priceOrder(lines, { code, stock })` returns `{ subtotal, discount, total }` or throws `OutOfStockError`.

Run the tests with `npm test` (Node 20 or newer, no dependencies).
